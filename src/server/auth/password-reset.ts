import { prisma } from "../db";
import { audit } from "../audit";
import { ApiError } from "../api";
import { randomToken, sha256 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { mailTransport, renderEmail } from "../alerts/mailer";
import { portalUrl } from "../sites";
import { hashPassword, passwordProblems } from "./password";

export const RESET_TTL_MS = 30 * 60_000;

export const RESET_REQUEST_MESSAGE =
  "If an account exists for that email address, we have sent a password reset link. The link expires in 30 minutes.";

/** Always answers the same way, whether or not the account exists (no account enumeration). */
export async function requestPasswordReset(emailInput: string, ip: string): Promise<{ message: string; emailed: boolean }> {
  const email = emailInput.trim().toLowerCase();
  const perEmail = await rateLimit(`pwreset:email:${sha256(email)}`, 3, 3600);
  if (!perEmail.allowed) return { message: RESET_REQUEST_MESSAGE, emailed: false };

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return { message: RESET_REQUEST_MESSAGE, emailed: false };

  // Only the newest link is valid.
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken(32);
  await prisma.passwordResetToken.create({
    data: { tokenHash: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS), ip },
  });
  await audit({ userId: user.id, ip, action: "auth.password_reset_requested" });

  const transport = mailTransport();
  if (!transport) {
    console.warn("[auth] password reset requested but SMTP is not configured; no email sent");
    return { message: RESET_REQUEST_MESSAGE, emailed: false };
  }
  const link = portalUrl(`/reset-password?token=${encodeURIComponent(token)}`);
  const subject = "Reset your TrustifyX Secure360 password";
  const lines = [
    "We received a request to reset the password for your TrustifyX Secure360 account.",
    "This link expires in 30 minutes and can be used once. If you did not request it, you can ignore this email.",
  ];
  try {
    await transport.send({ to: user.email, subject, text: `${lines.join("\n\n")}\n\n${link}`, html: renderEmail(subject, lines, { label: "Reset password", url: link }) });
    return { message: RESET_REQUEST_MESSAGE, emailed: true };
  } catch (err) {
    console.error("[auth] reset email failed", (err as Error).message);
    return { message: RESET_REQUEST_MESSAGE, emailed: false };
  }
}

export async function validateResetToken(token: string) {
  if (!token || token.length > 100) return null;
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt <= new Date()) return null;
  return row;
}

/** Sets a new password, consumes the token and signs the user out everywhere (both websites). */
export async function resetPassword(token: string, password: string, ip: string) {
  const row = await validateResetToken(token);
  if (!row) throw new ApiError(400, "This reset link is invalid or has expired. Request a new one.", "reset_invalid");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
  const problem = passwordProblems(password, user.email);
  if (problem) throw new ApiError(400, problem, "weak_password");

  const claimed = await prisma.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw new ApiError(400, "This reset link was already used.", "reset_invalid");
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await audit({ userId: user.id, ip, action: "auth.password_reset" });
}

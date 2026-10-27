import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "../db";
import { env } from "../env";
import { audit } from "../audit";
import { ApiError } from "../api";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { mailTransport, renderEmail } from "../alerts/mailer";
import { portalUrl, type Site } from "../sites";
import { verifyPassword } from "./password";
import { createSession, type NewSession } from "./session";
import { generateTotpSecret, matchTotp, otpauthUrl } from "./totp";

export const MFA_CHALLENGE_TTL_SEC = 5 * 60;
const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
const ENROLLMENT_TTL_MS = 15 * 60_000;
const RECOVERY_CODE_COUNT = 10;
const RESET_LINK_TTL_MS = 30 * 60_000;

export const MFA_RESET_REQUEST_MESSAGE =
  "If two-factor authentication can be reset for this account, we have emailed a confirmation link. The reset only takes effect after a waiting period, and you will be notified.";

interface Client {
  ip: string;
  userAgent?: string | null;
  site?: Site;
  persistent?: boolean;
}

// ─────────────────────────────── helpers ───────────────────────────────

const recoveryHash = (userId: string, code: string) => sha256(`${userId}:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);

/** 10 characters from a 32-symbol alphabet (50 bits), shown as xxxxx-xxxxx. */
function newRecoveryCode(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l to avoid transcription errors
  // 256 is a multiple of 32, so `byte % 32` is unbiased.
  const raw = Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

async function notify(userId: string, subject: string, lines: string[]) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  const transport = mailTransport();
  if (!user || !transport) return;
  try {
    await transport.send({ to: user.email, subject, text: lines.join("\n\n"), html: renderEmail(subject, lines) });
  } catch (err) {
    console.error("[mfa] notification failed", (err as Error).message);
  }
}

async function requirePassword(userId: string, password: string, ip: string) {
  const rl = await rateLimit(`mfa:reauth:${userId}`, 10, 900);
  if (!rl.allowed) throw new ApiError(429, "Too many attempts. Please try again later.", "rate_limited");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, password))) {
    await audit({ userId, ip, action: "mfa.reauth_failed" });
    throw new ApiError(401, "Your password is incorrect", "invalid_password");
  }
  return user;
}

/** Accepts a TOTP code once: the step must be newer than the last accepted one (replay prevention). */
async function consumeTotp(userId: string, secretEnc: string, code: string): Promise<boolean> {
  const step = matchTotp(decryptSecret(secretEnc), code);
  if (step === null) return false;
  const updated = await prisma.user.updateMany({
    where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return updated.count === 1;
}

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const updated = await prisma.mfaRecoveryCode.updateMany({
    where: { userId, codeHash: recoveryHash(userId, code), usedAt: null },
    data: { usedAt: new Date() },
  });
  return updated.count === 1;
}

/** Verifies a second factor for an enrolled user: a TOTP code or one unused recovery code. */
export async function verifySecondFactor(userId: string, input: { code?: string; recoveryCode?: string }): Promise<"totp" | "recovery" | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecretEnc: true, totpEnabledAt: true } });
  if (!user?.totpSecretEnc || !user.totpEnabledAt) return null;
  if (input.code && (await consumeTotp(userId, user.totpSecretEnc, input.code))) return "totp";
  if (input.recoveryCode && (await consumeRecoveryCode(userId, input.recoveryCode))) return "recovery";
  return null;
}

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: recoveryHash(userId, c) })) }),
  ]);
  return codes;
}

// ─────────────────────────────── status & enforcement ───────────────────────────────

/** True when the user must have 2FA: platform administrators, and owners/admins of enforcing organizations. */
export async function mfaRequiredFor(userId: string): Promise<{ required: boolean; reasons: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isPlatformAdmin: true, memberships: { select: { role: true, org: { select: { name: true, requireMfaForPrivileged: true } } } } },
  });
  const reasons: string[] = [];
  if (user?.isPlatformAdmin) reasons.push("TrustifyX platform administrators must use two-factor authentication.");
  for (const m of user?.memberships ?? []) {
    if (m.org.requireMfaForPrivileged && (m.role === "OWNER" || m.role === "ADMIN")) {
      reasons.push(`${m.org.name} requires two-factor authentication for owners and admins.`);
    }
  }
  return { required: reasons.length > 0, reasons };
}

export async function mfaStatus(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true } });
  const remaining = await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  const pendingReset = await prisma.mfaResetRequest.findFirst({
    where: { userId, confirmedAt: { not: null }, cancelledAt: null, completedAt: null },
    select: { id: true, effectiveAt: true },
  });
  const requirement = await mfaRequiredFor(userId);
  return {
    enabled: Boolean(user.totpEnabledAt),
    enabledAt: user.totpEnabledAt,
    recoveryCodesRemaining: user.totpEnabledAt ? remaining : 0,
    required: requirement.required,
    requiredReasons: requirement.reasons,
    pendingReset: pendingReset ? { effectiveAt: pendingReset.effectiveAt } : null,
  };
}

// ─────────────────────────────── enrollment ───────────────────────────────

export async function beginEnrollment(userId: string, password: string, ip: string) {
  const user = await requirePassword(userId, password, ip);
  if (user.totpEnabledAt) throw new ApiError(409, "Two-factor authentication is already enabled", "mfa_enabled");
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { totpPendingEnc: encryptSecret(secret), totpPendingAt: new Date() } });
  await audit({ userId, ip, action: "mfa.enrollment_started" });
  const uri = otpauthUrl(secret, user.email);
  const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  // Group the manual-entry key for readability; it is the same secret as in the QR code.
  return { secret: secret.replace(/(.{4})/g, "$1 ").trim(), qrSvg };
}

/**
 * Activates 2FA after the user proves the authenticator works. Returns the one-time recovery codes
 * (shown once, stored hashed). All other sessions of the user are signed out.
 */
export async function confirmEnrollment(userId: string, code: string, ip: string, keepSessionId?: string) {
  const rl = await rateLimit(`mfa:enroll:${userId}`, 10, 900);
  if (!rl.allowed) throw new ApiError(429, "Too many attempts. Please try again later.", "rate_limited");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabledAt) throw new ApiError(409, "Two-factor authentication is already enabled", "mfa_enabled");
  if (!user.totpPendingEnc || !user.totpPendingAt || Date.now() - user.totpPendingAt.getTime() > ENROLLMENT_TTL_MS) {
    throw new ApiError(400, "The setup has expired. Start again to get a new QR code.", "enrollment_expired");
  }
  const step = matchTotp(decryptSecret(user.totpPendingEnc), code);
  if (step === null) {
    await audit({ userId, ip, action: "mfa.enrollment_code_invalid" });
    throw new ApiError(400, "That code is not valid. Check the time on your phone and try the newest code.", "invalid_code");
  }
  const activated = await prisma.user.updateMany({
    where: { id: userId, totpEnabledAt: null, totpPendingEnc: user.totpPendingEnc },
    data: { totpSecretEnc: user.totpPendingEnc, totpEnabledAt: new Date(), totpLastStep: step, totpPendingEnc: null, totpPendingAt: null },
  });
  if (activated.count !== 1) throw new ApiError(409, "Two-factor authentication is already enabled", "mfa_enabled");
  const codes = await replaceRecoveryCodes(userId);
  await prisma.session.deleteMany({ where: { userId, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) } });
  await audit({ userId, ip, action: "mfa.enabled" });
  await notify(userId, "Two-factor authentication enabled", [
    "Two-factor authentication was turned on for your TrustifyX Secure360 account. Other signed-in devices were signed out.",
    "If this was not you, reset your password immediately and contact support.",
  ]);
  return { recoveryCodes: codes };
}

export async function regenerateRecoveryCodes(userId: string, password: string, code: string, ip: string) {
  await requirePassword(userId, password, ip);
  const ok = await verifySecondFactor(userId, { code });
  if (ok !== "totp") throw new ApiError(400, "Enter a current code from your authenticator app", "invalid_code");
  const codes = await replaceRecoveryCodes(userId);
  await audit({ userId, ip, action: "mfa.recovery_codes_regenerated" });
  await notify(userId, "New recovery codes created", ["New two-factor recovery codes were created for your account. Your previous codes no longer work."]);
  return { recoveryCodes: codes };
}

async function clearMfa(userId: string) {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, totpPendingEnc: null, totpPendingAt: null } }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaChallenge.deleteMany({ where: { userId } }),
  ]);
}

export async function disableMfa(userId: string, password: string, input: { code?: string; recoveryCode?: string }, ip: string) {
  await requirePassword(userId, password, ip);
  const requirement = await mfaRequiredFor(userId);
  if (requirement.required) throw new ApiError(403, requirement.reasons[0] ?? "Two-factor authentication is required for your account", "mfa_enforced");
  if (!(await verifySecondFactor(userId, input))) throw new ApiError(400, "That code is not valid", "invalid_code");
  await clearMfa(userId);
  await audit({ userId, ip, action: "mfa.disabled" });
  await notify(userId, "Two-factor authentication disabled", [
    "Two-factor authentication was turned off for your TrustifyX Secure360 account.",
    "If this was not you, reset your password immediately and contact support.",
  ]);
}

// ─────────────────────────────── login challenge ───────────────────────────────

export async function createMfaChallenge(userId: string, client: Client): Promise<string> {
  const token = randomToken(32);
  await prisma.mfaChallenge.create({
    data: {
      tokenHash: sha256(token),
      userId,
      site: client.site ?? "MARKETING",
      persistent: client.persistent ?? true,
      ip: client.ip,
      expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SEC * 1000),
    },
  });
  return token;
}

async function loadChallenge(token: string | undefined | null, site: Site) {
  if (!token || token.length > 100) return null;
  const ch = await prisma.mfaChallenge.findUnique({ where: { tokenHash: sha256(token) } });
  if (!ch || ch.site !== site || ch.expiresAt <= new Date() || ch.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS) return null;
  return ch;
}

/**
 * Second login step. On success the challenge is consumed and a brand-new session is created
 * (session rotation); the password-only step never produced a session.
 */
export async function completeMfaChallenge(
  token: string | undefined | null,
  input: { code?: string; recoveryCode?: string },
  client: Client & { site: Site },
): Promise<{ session: NewSession; userId: string; method: "totp" | "recovery"; recoveryCodesRemaining: number }> {
  const ch = await loadChallenge(token, client.site);
  if (!ch) throw new ApiError(401, "Your sign-in attempt expired. Enter your email and password again.", "mfa_challenge_expired");
  const rl = await rateLimit(`mfa:verify:${ch.userId}`, 10, 900);
  if (!rl.allowed) throw new ApiError(429, "Too many attempts. Please try again later.", "rate_limited");

  // Count the attempt first so parallel guesses cannot exceed the limit.
  const counted = await prisma.mfaChallenge.updateMany({
    where: { id: ch.id, attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) throw new ApiError(401, "Your sign-in attempt expired. Enter your email and password again.", "mfa_challenge_expired");

  const method = await verifySecondFactor(ch.userId, input);
  if (!method) {
    await audit({ userId: ch.userId, ip: client.ip, action: "auth.mfa_failed" });
    throw new ApiError(401, "That code is not valid. Try the newest code from your authenticator app.", "invalid_code");
  }
  const consumed = await prisma.mfaChallenge.deleteMany({ where: { id: ch.id } });
  if (consumed.count !== 1) throw new ApiError(401, "Your sign-in attempt expired. Enter your email and password again.", "mfa_challenge_expired");

  await prisma.user.update({ where: { id: ch.userId }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const membership = await prisma.membership.findFirst({ where: { userId: ch.userId }, orderBy: { createdAt: "asc" } });
  const session = await createSession({
    userId: ch.userId,
    orgId: membership?.orgId ?? null,
    ip: client.ip,
    userAgent: client.userAgent,
    site: client.site,
    persistent: ch.persistent,
  });
  const remaining = await prisma.mfaRecoveryCode.count({ where: { userId: ch.userId, usedAt: null } });
  await audit({ orgId: membership?.orgId, userId: ch.userId, ip: client.ip, action: "auth.login", targetType: "user", targetId: ch.userId, metadata: { secondFactor: method } });
  if (method === "recovery") {
    await notify(ch.userId, "A recovery code was used to sign in", [
      `A two-factor recovery code was used to sign in to your account. ${remaining} unused code${remaining === 1 ? "" : "s"} remain.`,
      "If this was not you, reset your password and create new recovery codes.",
    ]);
  }
  return { session, userId: ch.userId, method, recoveryCodesRemaining: remaining };
}

export async function purgeExpiredMfaChallenges() {
  await prisma.mfaChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

// ─────────────────────────────── account recovery ───────────────────────────────

/**
 * Lost authenticator AND recovery codes. Requires the password (an active login challenge), then
 * a link sent to the account email, then MFA_RESET_DELAY_HOURS waiting time during which the user
 * is notified and can cancel. There is deliberately no administrator or support override.
 */
export async function requestMfaReset(challengeToken: string | undefined | null, site: Site, ip: string) {
  const ch = await loadChallenge(challengeToken, site);
  if (!ch) throw new ApiError(401, "Your sign-in attempt expired. Enter your email and password again.", "mfa_challenge_expired");
  const rl = await rateLimit(`mfa:reset:${ch.userId}`, 3, 86400);
  if (!rl.allowed) return { message: MFA_RESET_REQUEST_MESSAGE };

  const token = randomToken(32);
  await prisma.$transaction([
    // Only the newest unconfirmed link is valid.
    prisma.mfaResetRequest.updateMany({ where: { userId: ch.userId, confirmedAt: null, cancelledAt: null }, data: { cancelledAt: new Date() } }),
    prisma.mfaResetRequest.create({ data: { userId: ch.userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_LINK_TTL_MS), ip } }),
  ]);
  await audit({ userId: ch.userId, ip, action: "mfa.reset_requested" });
  const link = portalUrl(`/mfa-reset?token=${encodeURIComponent(token)}`);
  const delay = env().MFA_RESET_DELAY_HOURS;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ch.userId }, select: { email: true } });
  const transport = mailTransport();
  if (transport) {
    const subject = "Confirm two-factor authentication reset";
    const lines = [
      "Someone who knows your password asked to remove two-factor authentication from your TrustifyX Secure360 account because the authenticator app and recovery codes were lost.",
      `If you confirm, two-factor authentication will be removed after a ${delay}-hour waiting period. You can cancel at any time before then.`,
      "If this was not you, do not click the link and change your password immediately.",
    ];
    try {
      await transport.send({ to: user.email, subject, text: `${lines.join("\n\n")}\n\n${link}`, html: renderEmail(subject, lines, { label: "Confirm reset request", url: link }) });
    } catch (err) {
      console.error("[mfa] reset email failed", (err as Error).message);
    }
  }
  return { message: MFA_RESET_REQUEST_MESSAGE };
}

async function findResetByToken(token: string) {
  if (!token || token.length > 100) return null;
  return prisma.mfaResetRequest.findUnique({ where: { tokenHash: sha256(token) } });
}

export async function confirmMfaReset(token: string, ip: string) {
  const r = await findResetByToken(token);
  if (!r || r.cancelledAt || r.completedAt) throw new ApiError(400, "This link is invalid or was cancelled.", "invalid_token");
  if (r.confirmedAt) return { effectiveAt: r.effectiveAt };
  if (r.expiresAt <= new Date()) throw new ApiError(400, "This link has expired. Start again from the sign-in page.", "invalid_token");
  const effectiveAt = new Date(Date.now() + env().MFA_RESET_DELAY_HOURS * 3600_000);
  await prisma.mfaResetRequest.update({ where: { id: r.id }, data: { confirmedAt: new Date(), effectiveAt } });
  await audit({ userId: r.userId, ip, action: "mfa.reset_confirmed", metadata: { effectiveAt: effectiveAt.toISOString() } });
  await notify(r.userId, "Two-factor authentication will be removed", [
    `Two-factor authentication will be removed from your account on ${effectiveAt.toUTCString()}.`,
    "If you did not ask for this, sign in and cancel it from Account Security, or open the link from the previous email again and choose Cancel. Then change your password.",
  ]);
  return { effectiveAt };
}

export async function cancelMfaReset(input: { token?: string; userId?: string }, ip: string) {
  const r = input.token
    ? await findResetByToken(input.token)
    : input.userId
      ? await prisma.mfaResetRequest.findFirst({ where: { userId: input.userId, cancelledAt: null, completedAt: null }, orderBy: { createdAt: "desc" } })
      : null;
  if (!r || r.cancelledAt || r.completedAt) return { cancelled: false };
  await prisma.mfaResetRequest.update({ where: { id: r.id }, data: { cancelledAt: new Date() } });
  await audit({ userId: r.userId, ip, action: "mfa.reset_cancelled" });
  await notify(r.userId, "Two-factor reset cancelled", ["The request to remove two-factor authentication from your account was cancelled."]);
  return { cancelled: true };
}

/** Called after a correct password: completes a confirmed reset whose waiting period has passed. */
export async function completeDueMfaReset(userId: string, ip: string): Promise<boolean> {
  const due = await prisma.mfaResetRequest.findFirst({
    where: { userId, confirmedAt: { not: null }, effectiveAt: { lte: new Date() }, cancelledAt: null, completedAt: null },
  });
  if (!due) return false;
  const claimed = await prisma.mfaResetRequest.updateMany({ where: { id: due.id, completedAt: null }, data: { completedAt: new Date() } });
  if (claimed.count !== 1) return false;
  await clearMfa(userId);
  await prisma.session.deleteMany({ where: { userId } });
  await audit({ userId, ip, action: "mfa.reset_completed", targetType: "mfa_reset", targetId: due.id });
  await notify(userId, "Two-factor authentication removed", [
    "Two-factor authentication was removed from your account after the waiting period. All devices were signed out.",
    "Set up two-factor authentication again from Account Security in the portal.",
  ]);
  return true;
}


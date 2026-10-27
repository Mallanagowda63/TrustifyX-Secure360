import type { OrgRole } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { audit } from "../audit";
import { ApiError } from "../api";
import { burnPasswordCheck, hashPassword, passwordProblems, verifyPassword } from "../auth/password";
import { createSession } from "../auth/session";
import { completeDueMfaReset, createMfaChallenge } from "../auth/mfa";
import type { Site } from "../sites";
import { marketingUrl } from "../sites";
import { randomToken, sha256 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { mailTransport, renderEmail } from "../alerts/mailer";
import { roleAtLeast } from "../auth/rbac";
import { assertCan, type Actor } from "./actor";
import { getEntitlement, requireEntitlement } from "../billing/entitlements";

const LOCK_AFTER_FAILURES = 10;
const LOCK_MINUTES = 15;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "org";
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

interface ClientInfo {
  ip: string;
  userAgent?: string | null;
  /** Website the session is created for (cookies are host-only). */
  site?: Site;
  /** "Remember me": persistent cookie for SESSION_TTL_HOURS; otherwise a browser-session cookie. */
  persistent?: boolean;
}

const sessionFor = (userId: string, orgId: string | null, client: ClientInfo) =>
  createSession({ userId, orgId, ip: client.ip, userAgent: client.userAgent, site: client.site, persistent: client.persistent });

export async function signup(input: { name: string; email: string; password: string; orgName: string }, client: ClientInfo) {
  if (!env().ALLOW_SIGNUP) throw new ApiError(403, "Self-service signup is disabled. Ask your administrator for an invitation.");
  const email = normalizeEmail(input.email);
  const problem = passwordProblems(input.password, email);
  if (problem) throw new ApiError(400, problem, "weak_password");

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, "An account with this email already exists. Sign in instead.", "exists");

  const passwordHash = await hashPassword(input.password);
  const { user, org } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, name: input.name.trim(), passwordHash, lastLoginAt: new Date() } });
    const org = await tx.organization.create({ data: { name: input.orgName.trim(), slug: slugify(input.orgName) } });
    await tx.membership.create({ data: { userId: user.id, orgId: org.id, role: "OWNER" } });
    return { user, org };
  });
  await audit({ orgId: org.id, userId: user.id, ip: client.ip, action: "auth.signup", targetType: "user", targetId: user.id });
  return { user, org, session: await sessionFor(user.id, org.id, client) };
}

export async function login(input: { email: string; password: string }, client: ClientInfo) {
  const email = normalizeEmail(input.email);
  const perEmail = await rateLimit(`login:email:${sha256(email)}`, 10, 900);
  if (!perEmail.allowed) throw new ApiError(429, "Too many login attempts. Please try again later.", "rate_limited");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await burnPasswordCheck(input.password);
    throw new ApiError(401, "Invalid email or password", "invalid_credentials");
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await burnPasswordCheck(input.password);
    throw new ApiError(423, "This account is temporarily locked after repeated failed sign-ins. Try again later.", "locked");
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    const failures = user.failedLogins + 1;
    const lock = failures >= LOCK_AFTER_FAILURES;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil },
    });
    await audit({ userId: user.id, ip: client.ip, action: lock ? "auth.locked" : "auth.login_failed", targetType: "user", targetId: user.id });
    throw new ApiError(401, "Invalid email or password", "invalid_credentials");
  }
  let mfaWasReset = false;
  if (user.totpEnabledAt) {
    mfaWasReset = await completeDueMfaReset(user.id, client.ip);
    if (!mfaWasReset) {
      // Password step passed; no session exists until the second factor is verified.
      await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
      await audit({ userId: user.id, ip: client.ip, action: "auth.mfa_challenge", targetType: "user", targetId: user.id });
      return { kind: "mfa" as const, user, mfaChallenge: await createMfaChallenge(user.id, client) };
    }
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const membership = await prisma.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  await audit({ orgId: membership?.orgId, userId: user.id, ip: client.ip, action: "auth.login", targetType: "user", targetId: user.id });
  return {
    kind: "session" as const,
    user,
    mfaWasReset,
    session: await sessionFor(user.id, membership?.orgId ?? null, client),
  };
}

export async function switchOrg(sessionId: string, userId: string, orgId: string) {
  const m = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId } } });
  if (!m) throw new ApiError(404, "Organization not found", "not_found");
  await prisma.session.update({ where: { id: sessionId }, data: { activeOrgId: orgId } });
}

export async function listUserOrgs(userId: string) {
  const ms = await prisma.membership.findMany({
    where: { userId },
    include: { org: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return ms.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }));
}

// ─── Team management ───

export async function listMembers(orgId: string) {
  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invitation.findMany({
      where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    }),
  ]);
  return {
    members: members.map((m) => ({ id: m.id, role: m.role, joinedAt: m.createdAt, user: m.user })),
    invitations,
  };
}

export async function inviteMember(actor: Actor, input: { email: string; role: OrgRole }) {
  assertCan(actor, "team.manage");
  if (input.role === "OWNER" && actor.role !== "OWNER") throw new ApiError(403, "Only owners can invite owners");
  const email = normalizeEmail(input.email);
  const already = await prisma.membership.findFirst({ where: { orgId: actor.orgId, user: { email } } });
  if (already) throw new ApiError(409, "This person is already a member");
  const ent = await requireEntitlement(actor.orgId);
  const [members, pendingInvites] = await Promise.all([
    prisma.membership.count({ where: { orgId: actor.orgId } }),
    prisma.invitation.count({ where: { orgId: actor.orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  if (members + pendingInvites >= ent.limits.members) {
    throw new ApiError(400, `Your ${ent.plan?.name ?? ""} plan includes up to ${ent.limits.members} team member(s). Upgrade to add more.`, "plan_limit");
  }

  const token = randomToken(32);
  const inv = await prisma.invitation.create({
    data: {
      orgId: actor.orgId,
      email,
      role: input.role,
      tokenHash: sha256(token),
      invitedById: actor.userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
    include: { org: { select: { name: true } } },
  });
  const link = marketingUrl(`/invite/${token}`);
  let emailed = false;
  const t = mailTransport();
  if (t) {
    const subject = `You're invited to ${inv.org.name} on TrustifyX Secure360`;
    const lines = [`You have been invited to join ${inv.org.name} as ${input.role.toLowerCase()}.`, "This invitation expires in 7 days."];
    try {
      await t.send({ to: email, subject, text: `${lines.join("\n\n")}\n\n${link}`, html: renderEmail(subject, lines, { label: "Accept invitation", url: link }) });
      emailed = true;
    } catch (err) {
      console.error("[invite] email failed", (err as Error).message);
    }
  }
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "team.invite", targetType: "invitation", targetId: inv.id, metadata: { email, role: input.role } });
  // The link is shown once to the inviting admin so invitations work without SMTP.
  return { id: inv.id, email, role: inv.role, expiresAt: inv.expiresAt, link, emailed };
}

export async function revokeInvitation(actor: Actor, id: string) {
  assertCan(actor, "team.manage");
  const res = await prisma.invitation.updateMany({ where: { id, orgId: actor.orgId, acceptedAt: null }, data: { revokedAt: new Date() } });
  if (!res.count) throw new ApiError(404, "Invitation not found");
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "team.invite_revoked", targetType: "invitation", targetId: id });
}

export async function findInvitation(token: string) {
  const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(token) }, include: { org: { select: { id: true, name: true } } } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt.getTime() < Date.now()) return null;
  return inv;
}

export async function acceptInvitation(
  input: { token: string; name?: string; password?: string },
  current: { userId: string; email: string } | null,
  client: ClientInfo,
) {
  const inv = await findInvitation(input.token);
  if (!inv) throw new ApiError(404, "This invitation is invalid or has expired");

  const ent = await getEntitlement(inv.orgId);
  const memberCount = await prisma.membership.count({ where: { orgId: inv.orgId } });
  if (memberCount >= ent.limits.members) {
    throw new ApiError(400, "This organization has reached its team-member limit. Ask an admin to upgrade the plan.", "plan_limit");
  }

  let userId: string;
  if (current) {
    if (normalizeEmail(current.email) !== inv.email) {
      throw new ApiError(403, `This invitation was sent to ${inv.email}. Sign in with that account to accept it.`);
    }
    userId = current.userId;
  } else {
    const existing = await prisma.user.findUnique({ where: { email: inv.email } });
    if (existing) throw new ApiError(409, "An account already exists for this email. Sign in first, then open the invitation link again.", "login_required");
    if (!input.name?.trim() || !input.password) throw new ApiError(400, "Name and password are required");
    const problem = passwordProblems(input.password, inv.email);
    if (problem) throw new ApiError(400, problem, "weak_password");
    const user = await prisma.user.create({ data: { email: inv.email, name: input.name.trim(), passwordHash: await hashPassword(input.password) } });
    userId = user.id;
  }

  await prisma.$transaction([
    prisma.membership.upsert({
      where: { userId_orgId: { userId, orgId: inv.orgId } },
      create: { userId, orgId: inv.orgId, role: inv.role },
      update: {},
    }),
    prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
  ]);
  await audit({ orgId: inv.orgId, userId, ip: client.ip, action: "team.invite_accepted", targetType: "invitation", targetId: inv.id });
  const session = current ? null : await sessionFor(userId, inv.orgId, client);
  return { orgId: inv.orgId, session };
}

export async function changeMemberRole(actor: Actor, membershipId: string, role: OrgRole) {
  assertCan(actor, "team.manage");
  const m = await prisma.membership.findFirst({ where: { id: membershipId, orgId: actor.orgId } });
  if (!m) throw new ApiError(404, "Member not found");
  if ((role === "OWNER" || m.role === "OWNER") && actor.role !== "OWNER") throw new ApiError(403, "Only owners can change owner roles");
  if (!roleAtLeast(actor.role, role)) throw new ApiError(403, "You cannot grant a role higher than your own");
  if (m.role === "OWNER" && role !== "OWNER") await assertNotLastOwner(actor.orgId, m.id);
  const updated = await prisma.membership.update({ where: { id: m.id }, data: { role } });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "team.role_changed", targetType: "membership", targetId: m.id, metadata: { from: m.role, to: role, memberUserId: m.userId } });
  return updated;
}

export async function removeMember(actor: Actor, membershipId: string) {
  const m = await prisma.membership.findFirst({ where: { id: membershipId, orgId: actor.orgId } });
  if (!m) throw new ApiError(404, "Member not found");
  const self = m.userId === actor.userId;
  if (!self) assertCan(actor, "team.manage");
  if (m.role === "OWNER" && !self && actor.role !== "OWNER") throw new ApiError(403, "Only owners can remove owners");
  if (m.role === "OWNER") await assertNotLastOwner(actor.orgId, m.id);
  await prisma.membership.delete({ where: { id: m.id } });
  // Sessions pointing at this org fall back to another membership on next request.
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: self ? "team.left" : "team.member_removed", targetType: "membership", targetId: m.id, metadata: { memberUserId: m.userId } });
}

async function assertNotLastOwner(orgId: string, excludingMembershipId: string) {
  const others = await prisma.membership.count({ where: { orgId, role: "OWNER", id: { not: excludingMembershipId } } });
  if (others === 0) throw new ApiError(400, "An organization must keep at least one owner");
}

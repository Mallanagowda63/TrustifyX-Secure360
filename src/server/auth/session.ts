import type { OrgRole, Session, User } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { randomToken, sha256 } from "../security/crypto";
import type { Site } from "../sites";

export interface SessionContext {
  session: Session;
  user: Pick<User, "id" | "email" | "name" | "isPlatformAdmin" | "totpEnabledAt">;
  org: { id: string; name: string; slug: string; requireMfaForPrivileged: boolean } | null;
  role: OrgRole | null;
}

export function sessionCookieName(): string {
  // __Host- prefix forces Secure, Path=/ and no Domain attribute (only valid over HTTPS).
  return env().APP_URL.startsWith("https://") ? "__Host-tx_session" : "tx_session";
}
export function csrfCookieName(): string {
  return env().APP_URL.startsWith("https://") ? "__Host-tx_csrf" : "tx_csrf";
}

export interface NewSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  /** false = browser-session cookie (no "remember me"). */
  persistent: boolean;
}

/**
 * Creates a fresh session (new random token on every login/SSO, i.e. session rotation).
 * Sessions are bound to one website; their cookies are host-only.
 */
export async function createSession(params: {
  userId: string;
  orgId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  site?: Site;
  persistent?: boolean;
  ssoGroupId?: string | null;
}): Promise<NewSession> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const persistent = params.persistent ?? true;
  const ttl = persistent ? env().SESSION_TTL_HOURS : env().SESSION_SHORT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttl * 3600_000);
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      csrfToken,
      userId: params.userId,
      activeOrgId: params.orgId,
      site: params.site ?? "MARKETING",
      persistent,
      ssoGroupId: params.ssoGroupId ?? null,
      ip: params.ip ?? null,
      userAgent: params.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
  });
  return { token, csrfToken, expiresAt, persistent };
}

/** Resolves a raw session token into user + active org membership. */
export async function resolveSession(token: string | undefined | null, site?: Site): Promise<SessionContext | null> {
  if (!token || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true, isPlatformAdmin: true, totpEnabledAt: true } } },
  });
  if (!session) return null;
  // A session only works on the website it was issued for.
  if (site && session.site !== site) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  // Sliding activity timestamp, written at most once per 5 minutes.
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }

  let membership = session.activeOrgId
    ? await prisma.membership.findUnique({
        where: { userId_orgId: { userId: session.userId, orgId: session.activeOrgId } },
        include: { org: { select: { id: true, name: true, slug: true, requireMfaForPrivileged: true } } },
      })
    : null;

  if (!membership) {
    // Active org removed or never set: fall back to the user's first membership.
    membership = await prisma.membership.findFirst({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
      include: { org: { select: { id: true, name: true, slug: true, requireMfaForPrivileged: true } } },
    });
    if (membership && membership.orgId !== session.activeOrgId) {
      await prisma.session.update({ where: { id: session.id }, data: { activeOrgId: membership.orgId } });
    }
  }

  const { user, ...rest } = session;
  return {
    session: rest as Session,
    user,
    org: membership?.org ?? null,
    role: membership?.role ?? null,
  };
}

/**
 * True when this organization requires two-factor authentication for owners/admins and the
 * signed-in user (an owner/admin there) has not set it up yet. Such users may only reach the
 * Account Security page until they enroll.
 */
export function mfaEnrollmentRequired(s: Pick<SessionContext, "user" | "org" | "role">): boolean {
  return !s.user.totpEnabledAt && Boolean(s.org?.requireMfaForPrivileged) && (s.role === "OWNER" || s.role === "ADMIN");
}

/** Replaces a session with a new token (same user, site, org and lifetime policy). */
export async function rotateSession(old: Session): Promise<NewSession> {
  const fresh = await createSession({
    userId: old.userId,
    orgId: old.activeOrgId,
    ip: old.ip,
    userAgent: old.userAgent,
    site: old.site as Site,
    persistent: old.persistent,
    ssoGroupId: old.ssoGroupId,
  });
  await prisma.session.deleteMany({ where: { id: old.id } });
  return fresh;
}

/** Signs out: removes this session and any session linked to it by SSO (the other website). */
export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) } });
  if (!session) return;
  await prisma.session.deleteMany({
    where: session.ssoGroupId ? { OR: [{ id: session.id }, { ssoGroupId: session.ssoGroupId }] } : { id: session.id },
  });
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

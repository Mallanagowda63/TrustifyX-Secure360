import type { OrgRole, Session, User } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { randomToken, sha256 } from "../security/crypto";

export interface SessionContext {
  session: Session;
  user: Pick<User, "id" | "email" | "name" | "isPlatformAdmin">;
  org: { id: string; name: string; slug: string } | null;
  role: OrgRole | null;
}

export function sessionCookieName(): string {
  // __Host- prefix forces Secure, Path=/ and no Domain attribute (only valid over HTTPS).
  return env().APP_URL.startsWith("https://") ? "__Host-tx_session" : "tx_session";
}
export function csrfCookieName(): string {
  return env().APP_URL.startsWith("https://") ? "__Host-tx_csrf" : "tx_csrf";
}

export async function createSession(params: {
  userId: string;
  orgId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3600_000);
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      csrfToken,
      userId: params.userId,
      activeOrgId: params.orgId,
      ip: params.ip ?? null,
      userAgent: params.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
  });
  return { token, csrfToken, expiresAt };
}

/** Resolves a raw session token into user + active org membership. */
export async function resolveSession(token: string | undefined | null): Promise<SessionContext | null> {
  if (!token || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true, isPlatformAdmin: true } } },
  });
  if (!session) return null;
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
        include: { org: { select: { id: true, name: true, slug: true } } },
      })
    : null;

  if (!membership) {
    // Active org removed or never set: fall back to the user's first membership.
    membership = await prisma.membership.findFirst({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
      include: { org: { select: { id: true, name: true, slug: true } } },
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

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

import { safeNextPath, type Site } from "@/lib/site-routing";
import { prisma } from "../db";
import { audit } from "../audit";
import { ApiError } from "../api";
import { randomToken, sha256 } from "../security/crypto";
import { createSession, type NewSession, type SessionContext } from "./session";

/**
 * Single sign-on between the marketing website and the security portal (separate hostnames,
 * separate host-only cookies, one user database). Authorization-code flow with state:
 *
 *   1. TARGET  /sso/begin?next=…      sets a random `state` cookie (HttpOnly, 5 min) and redirects to
 *   2. SOURCE  /sso/authorize?state=… which, if signed in there, stores a single-use code bound to
 *                                     hash(state) and the target site (60 s TTL, hash only), then
 *   3. TARGET  /sso/callback?code&state checks state == cookie and redeems the code atomically,
 *                                     creating a NEW session on the target (rotation).
 * No session token ever appears in a URL; an attacker's code cannot be redeemed in a victim's
 * browser because the state cookie would not match (login CSRF).
 */

export const SSO_CODE_TTL_MS = 60_000;
export const SSO_STATE_TTL_SEC = 300;
export const SSO_STATE_COOKIE = "tx_sso_state";

export function newSsoState(): string {
  return randomToken(24);
}

export async function issueSsoCode(source: SessionContext, params: { targetSite: Site; state: string; next: string | null }) {
  if (!params.state || params.state.length < 20 || params.state.length > 100) throw new ApiError(400, "Invalid SSO request");
  // Link both sessions so signing out of one website signs out of the other too.
  let groupId = source.session.ssoGroupId;
  if (!groupId) {
    groupId = randomToken(16);
    await prisma.session.update({ where: { id: source.session.id }, data: { ssoGroupId: groupId } });
  }
  const code = randomToken(32);
  await prisma.ssoCode.create({
    data: {
      codeHash: sha256(code),
      stateHash: sha256(params.state),
      userId: source.user.id,
      orgId: source.org?.id ?? null,
      targetSite: params.targetSite,
      nextPath: safeNextPath(params.targetSite, params.next, "/"),
      groupId,
      persistent: source.session.persistent,
      expiresAt: new Date(Date.now() + SSO_CODE_TTL_MS),
    },
  });
  return code;
}

export async function redeemSsoCode(params: {
  code: string;
  state: string;
  stateCookie: string | null | undefined;
  site: Site;
  ip: string;
  userAgent: string | null;
}): Promise<{ session: NewSession; nextPath: string }> {
  const invalid = () => new ApiError(400, "This sign-in link is invalid or has expired. Please sign in.", "sso_invalid");
  if (!params.code || params.code.length > 100 || !params.state || !params.stateCookie) throw invalid();
  if (sha256(params.state) !== sha256(params.stateCookie)) throw invalid();

  const codeHash = sha256(params.code);
  // Atomic single use: only one request can flip usedAt.
  const claimed = await prisma.ssoCode.updateMany({
    where: { codeHash, stateHash: sha256(params.state), targetSite: params.site, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw invalid();
  const row = await prisma.ssoCode.findUniqueOrThrow({ where: { codeHash } });
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || (user.lockedUntil && user.lockedUntil > new Date())) throw invalid();
  const orgStillValid = row.orgId ? await prisma.membership.findUnique({ where: { userId_orgId: { userId: user.id, orgId: row.orgId } } }) : null;

  const session = await createSession({
    userId: user.id,
    orgId: orgStillValid ? row.orgId : null,
    ip: params.ip,
    userAgent: params.userAgent,
    site: params.site,
    persistent: row.persistent,
    ssoGroupId: row.groupId,
  });
  await audit({ orgId: row.orgId, userId: user.id, ip: params.ip, action: "auth.sso", metadata: { site: params.site } });
  return { session, nextPath: row.nextPath };
}

export async function purgeExpiredSsoCodes() {
  await prisma.ssoCode.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3600_000) } } });
}

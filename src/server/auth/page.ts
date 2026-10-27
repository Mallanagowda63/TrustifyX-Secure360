import "server-only";
import { cookies, headers } from "next/headers";
import { siteForHost, type Site } from "../sites";
import { redirect } from "next/navigation";
import { can, type Permission } from "./rbac";
import { mfaEnrollmentRequired, resolveSession, sessionCookieName, type SessionContext } from "./session";

/** The website (marketing or portal) the current page request was made to. */
export async function currentSite(): Promise<Site> {
  return siteForHost((await headers()).get("host"));
}

export async function getPageSession(): Promise<SessionContext | null> {
  const store = await cookies();
  return resolveSession(store.get(sessionCookieName())?.value, await currentSite());
}

/** For server-rendered pages: redirects to /login when not signed in. */
export async function requirePageSession(permission?: Permission, opts: { mfaExempt?: boolean } = {}) {
  const s = await getPageSession();
  if (!s) redirect("/login");
  if (!s.org || !s.role) redirect("/login?error=no_org");
  if (!opts.mfaExempt && mfaEnrollmentRequired(s)) redirect("/account-security?required=1");
  if (permission && !can(s.role, permission)) redirect("/dashboard?error=forbidden");
  return { ...s, org: s.org, role: s.role };
}

import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { can, type Permission } from "./rbac";
import { resolveSession, sessionCookieName, type SessionContext } from "./session";

export async function getPageSession(): Promise<SessionContext | null> {
  const store = await cookies();
  return resolveSession(store.get(sessionCookieName())?.value);
}

/** For server-rendered pages: redirects to /login when not signed in. */
export async function requirePageSession(permission?: Permission) {
  const s = await getPageSession();
  if (!s) redirect("/login");
  if (!s.org || !s.role) redirect("/login?error=no_org");
  if (permission && !can(s.role, permission)) redirect("/dashboard?error=forbidden");
  return { ...s, org: s.org, role: s.role };
}

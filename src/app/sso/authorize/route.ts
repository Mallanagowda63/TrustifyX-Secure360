import { NextResponse, type NextRequest } from "next/server";
import { clientIp, requestSite } from "@/server/api";
import { resolveSession, sessionCookieName } from "@/server/auth/session";
import { issueSsoCode } from "@/server/auth/sso";
import { otherSite } from "@/server/auth/sso-http";
import { safeNextPath } from "@/lib/site-routing";
import { siteUrl } from "@/server/sites";
import { rateLimit } from "@/server/security/rate-limit";

export const dynamic = "force-dynamic";

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** Step 2 (on the site where the user may already be signed in): issue a one-time code. */
export async function GET(req: NextRequest) {
  const site = requestSite(req);
  const target = otherSite(site);
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const next = safeNextPath(target, req.nextUrl.searchParams.get("next"), "/");

  const rl = await rateLimit(`sso-authorize:${clientIp(req)}`, 60, 600);
  const session = rl.allowed ? await resolveSession(req.cookies.get(sessionCookieName())?.value, site) : null;
  if (!session) {
    // Not signed in here: let the user sign in on the site they wanted to open.
    const login = new URL(siteUrl(target, "/login"));
    login.searchParams.set("next", next);
    return noStore(NextResponse.redirect(login, 303));
  }
  const code = await issueSsoCode(session, { targetSite: target, state, next }).catch(() => null);
  if (!code) return noStore(NextResponse.redirect(new URL(siteUrl(target, "/login")), 303));
  const callback = new URL(siteUrl(target, "/sso/callback"));
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  return noStore(NextResponse.redirect(callback, 303));
}

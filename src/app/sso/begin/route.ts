import { NextResponse, type NextRequest } from "next/server";
import { requestSite } from "@/server/api";
import { newSsoState, SSO_STATE_COOKIE } from "@/server/auth/sso";
import { otherSite, ssoStateCookieOptions } from "@/server/auth/sso-http";
import { safeNextPath } from "@/lib/site-routing";
import { siteUrl } from "@/server/sites";

export const dynamic = "force-dynamic";

/** Step 1 (on the site the user wants to open): bind a random state to this browser, ask the other site. */
export function GET(req: NextRequest) {
  const site = requestSite(req);
  const next = safeNextPath(site, req.nextUrl.searchParams.get("next"), "/");
  const state = newSsoState();
  const target = new URL(siteUrl(otherSite(site), "/sso/authorize"));
  target.searchParams.set("state", state);
  target.searchParams.set("next", next);
  const res = NextResponse.redirect(target, 303);
  res.cookies.set(SSO_STATE_COOKIE, state, ssoStateCookieOptions());
  res.headers.set("Cache-Control", "no-store");
  return res;
}

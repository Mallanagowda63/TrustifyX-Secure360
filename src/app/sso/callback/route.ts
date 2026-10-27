import { NextResponse, type NextRequest } from "next/server";
import { clientIp, requestSite } from "@/server/api";
import { withSessionCookies } from "@/server/auth/cookies";
import { redeemSsoCode, SSO_STATE_COOKIE } from "@/server/auth/sso";
import { ssoStateCookieOptions, userAgentOf } from "@/server/auth/sso-http";
import { rateLimit } from "@/server/security/rate-limit";
import { siteUrl } from "@/server/sites";

export const dynamic = "force-dynamic";

/** Step 3 (back on the site the user wants to open): redeem the code for a fresh local session. */
export async function GET(req: NextRequest) {
  const site = requestSite(req);
  const ip = clientIp(req);
  const finish = (res: NextResponse) => {
    res.cookies.set(SSO_STATE_COOKIE, "", { ...ssoStateCookieOptions(), maxAge: 0 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const fail = () => finish(NextResponse.redirect(new URL(siteUrl(site, "/login?error=sso")), 303));

  const rl = await rateLimit(`sso-callback:${ip}`, 30, 600);
  if (!rl.allowed) return fail();
  try {
    const { session, nextPath } = await redeemSsoCode({
      code: req.nextUrl.searchParams.get("code") ?? "",
      state: req.nextUrl.searchParams.get("state") ?? "",
      stateCookie: req.cookies.get(SSO_STATE_COOKIE)?.value,
      site,
      ip,
      userAgent: userAgentOf(req),
    });
    return finish(withSessionCookies(NextResponse.redirect(new URL(siteUrl(site, nextPath)), 303), session));
  } catch {
    return fail();
  }
}

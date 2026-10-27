import { NextResponse, type NextRequest } from "next/server";
import { decideRoute, type Site } from "@/lib/site-routing";

/**
 * Hostname-based routing for the two public websites served by this app:
 * the marketing/purchase site (APP_URL) and the login-only security portal (PORTAL_URL).
 * Authorization is NOT done here; every page and API checks the session server-side.
 */
const marketingBase = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const portalBase = () => (process.env.PORTAL_URL ?? "http://portal.localhost:3000").replace(/\/$/, "");

function siteOf(req: NextRequest): Site {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  return host === new URL(portalBase()).host.toLowerCase() ? "PORTAL" : "MARKETING";
}

export function proxy(req: NextRequest) {
  const site = siteOf(req);
  const decision = decideRoute(site, req.nextUrl.pathname);
  switch (decision.action) {
    case "next":
      return NextResponse.next();
    case "rewrite": {
      const url = req.nextUrl.clone();
      url.pathname = decision.path;
      return NextResponse.rewrite(url);
    }
    case "redirect": {
      const base = decision.site === "PORTAL" ? portalBase() : marketingBase();
      const target = new URL(`${base}${decision.path}`);
      if (!decision.path.includes("#")) req.nextUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));
      if (decision.site === site) return NextResponse.redirect(target, 307);
      // Cross-site: issue the redirect from a route handler (see src/app/sso/site-redirect).
      const encoded = Buffer.from(`${target.pathname}${target.search}${target.hash}`, "utf8").toString("base64url");
      const url = req.nextUrl.clone();
      url.pathname = `/sso/site-redirect/${decision.site}/${encoded}`;
      url.search = "";
      return NextResponse.rewrite(url);
    }
    case "notFound": {
      const url = req.nextUrl.clone();
      url.pathname = "/__not-found";
      return NextResponse.rewrite(url);
    }
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

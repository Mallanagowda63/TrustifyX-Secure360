import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath, type Site } from "@/lib/site-routing";
import { siteUrl } from "@/server/sites";

export const dynamic = "force-dynamic";

/**
 * Cross-site navigation helper used by buttons like "Open Security Dashboard":
 * /sso/open?target=portal&next=/check  →  <portal>/sso/begin?next=/check (which starts SSO).
 */
export function GET(req: NextRequest) {
  const target: Site = req.nextUrl.searchParams.get("target") === "marketing" ? "MARKETING" : "PORTAL";
  const next = safeNextPath(target, req.nextUrl.searchParams.get("next"), "/");
  const url = new URL(siteUrl(target, "/sso/begin"));
  url.searchParams.set("next", next);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

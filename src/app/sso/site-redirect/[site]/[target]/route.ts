import { NextResponse, type NextRequest } from "next/server";
import { siteUrl } from "@/server/sites";

export const dynamic = "force-dynamic";

/**
 * Cross-site redirect issued by src/proxy.ts (e.g. portal /signup → marketing /#pricing), as
 * /sso/site-redirect/<SITE>/<base64url(path)>. Done in a route handler because Next's proxy layer
 * rewrites absolute redirects whose host is "localhost" into relative ones, which breaks local
 * two-host development. Only our two configured websites are possible targets, and only with a
 * same-site relative path.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ site: string; target: string }> }) {
  const { site, target } = await ctx.params;
  let path = "/";
  try {
    path = Buffer.from(target, "base64url").toString("utf8");
  } catch {
    path = "/";
  }
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\") || /[\r\n]/.test(path) || path.length > 1024) path = "/";
  return NextResponse.redirect(new URL(siteUrl(site === "PORTAL" ? "PORTAL" : "MARKETING", path)), 307);
}

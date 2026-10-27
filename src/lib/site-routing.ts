/**
 * Two public websites served by one Next.js app:
 *   MARKETING (APP_URL, e.g. secure360.trustifyx.in) — homepage, pricing, signup, checkout, account/billing
 *   PORTAL    (PORTAL_URL, e.g. portal.trustifyx.in) — login-only security command center
 * This module is pure (no env, no I/O) so it can run in src/proxy.ts and be unit tested.
 */

export type Site = "MARKETING" | "PORTAL";

export type RouteDecision =
  | { action: "next" }
  | { action: "rewrite"; path: string }
  | { action: "redirect"; site: Site; path: string }
  | { action: "notFound" };

/** Paths (first segment) that belong to the security portal. */
const PORTAL_PREFIXES = [
  "/dashboard",
  "/websites",
  "/check",
  "/findings",
  "/assistant",
  "/incidents",
  "/reports",
  "/billing",
  "/settings",
  "/integrations",
  "/audit",
  "/admin",
  "/forgot-password",
  "/reset-password",
  "/account-security",
  "/mfa-reset",
  "/protection",
  "/security-events",
  "/scans",
  "/servers",
];

/** Paths that belong only to the marketing / purchase website. */
const MARKETING_PREFIXES = [
  "/signup",
  "/checkout",
  "/account",
  "/about",
  "/contact",
  "/legal",
  "/security-disclosure",
  "/invite",
];

/** Internal route that renders the portal's own login page (reached only via rewrite). */
export const PORTAL_LOGIN_ROUTE = "/portal-login";

/** Served identically on both hosts. */
const SHARED_PREFIXES = ["/api", "/sso", "/_next", "/.well-known", "/robots.txt", "/sitemap.xml", "/favicon"];

const matches = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const hasPrefix = (path: string, list: string[]) => list.some((p) => matches(path, p));

export function isPortalPath(path: string): boolean {
  return hasPrefix(path, PORTAL_PREFIXES) || path === "/login" || path === "/";
}

export function decideRoute(site: Site, pathname: string): RouteDecision {
  const path = pathname || "/";
  if (hasPrefix(path, SHARED_PREFIXES)) return { action: "next" };

  if (site === "PORTAL") {
    if (path === "/") return { action: "rewrite", path: "/dashboard" };
    if (path === "/login") return { action: "rewrite", path: PORTAL_LOGIN_ROUTE };
    if (matches(path, PORTAL_LOGIN_ROUTE)) return { action: "redirect", site: "PORTAL", path: "/login" };
    if (hasPrefix(path, PORTAL_PREFIXES)) return { action: "next" };
    // No signup, pricing checkout or marketing pages on the portal.
    if (matches(path, "/signup") || matches(path, "/checkout")) return { action: "redirect", site: "MARKETING", path: "/#pricing" };
    if (hasPrefix(path, MARKETING_PREFIXES)) return { action: "redirect", site: "MARKETING", path };
    return { action: "notFound" };
  }

  // MARKETING
  if (matches(path, PORTAL_LOGIN_ROUTE)) return { action: "redirect", site: "PORTAL", path: "/login" };
  if (matches(path, "/dashboard")) return { action: "redirect", site: "PORTAL", path: "/" };
  if (hasPrefix(path, PORTAL_PREFIXES)) return { action: "redirect", site: "PORTAL", path };
  return { action: "next" };
}

/**
 * Validates a post-login / SSO destination: a same-site relative path that belongs to the
 * target website. Anything else (absolute URLs, //host, /\host, other site's pages) falls back.
 */
export function safeNextPath(site: Site, next: string | null | undefined, fallback = "/"): string {
  if (!next || typeof next !== "string" || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n\t]/.test(next)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(next, "http://placeholder.invalid");
  } catch {
    return fallback;
  }
  if (parsed.host !== "placeholder.invalid") return fallback;
  const path = parsed.pathname;
  if (hasPrefix(path, ["/api", "/sso", "/_next"]) || matches(path, PORTAL_LOGIN_ROUTE)) return fallback;
  if (site === "PORTAL" && !(isPortalPath(path) && path !== "/login")) return fallback;
  if (site === "MARKETING" && hasPrefix(path, PORTAL_PREFIXES)) return fallback;
  return `${path}${parsed.search}${parsed.hash}`;
}

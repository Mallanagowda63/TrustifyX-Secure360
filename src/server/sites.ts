import type { Site } from "@/lib/site-routing";
import { env } from "./env";

export type { Site };

const strip = (u: string) => u.replace(/\/$/, "");

/** Public marketing / purchase website (APP_URL). */
export function marketingUrl(path = ""): string {
  return `${strip(env().APP_URL)}${path}`;
}

/** Customer security portal (PORTAL_URL). */
export function portalUrl(path = ""): string {
  return `${strip(env().PORTAL_URL)}${path}`;
}

export function siteUrl(site: Site, path = ""): string {
  return site === "PORTAL" ? portalUrl(path) : marketingUrl(path);
}

/** Maps a request Host header to a site. Unknown hosts are treated as the marketing site. */
export function siteForHost(host: string | null | undefined): Site {
  if (!host) return "MARKETING";
  const h = host.toLowerCase();
  return h === new URL(env().PORTAL_URL).host.toLowerCase() ? "PORTAL" : "MARKETING";
}

/** Origins allowed to make state-changing requests (CSRF origin check). */
export function allowedOrigins(): string[] {
  return [new URL(env().APP_URL).origin, new URL(env().PORTAL_URL).origin];
}

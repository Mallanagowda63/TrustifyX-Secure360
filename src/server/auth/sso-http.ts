import type { NextRequest } from "next/server";
import { env } from "../env";
import type { Site } from "../sites";

export const otherSite = (s: Site): Site => (s === "PORTAL" ? "MARKETING" : "PORTAL");

export function ssoStateCookieOptions() {
  return {
    httpOnly: true,
    secure: env().APP_URL.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/sso",
    maxAge: 300,
  };
}

export const userAgentOf = (req: NextRequest) => req.headers.get("user-agent");

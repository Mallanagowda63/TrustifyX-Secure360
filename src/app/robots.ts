import type { MetadataRoute } from "next";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = env().APP_URL.replace(/\/$/, "");
  return {
    rules: [{ userAgent: "*", allow: ["/", "/legal/", "/about", "/contact", "/security-disclosure"], disallow: ["/api/", "/dashboard", "/websites", "/findings", "/billing", "/checkout", "/admin", "/settings"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}

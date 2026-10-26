import { env } from "@/server/env";

/** RFC 9116 security contact. */
export function GET() {
  const e = env();
  const base = e.APP_URL.replace(/\/$/, "");
  const expires = new Date(Date.now() + 180 * 86_400_000).toISOString();
  const body = [`Contact: mailto:${e.SECURITY_EMAIL}`, `Expires: ${expires}`, `Policy: ${base}/security-disclosure`, "Preferred-Languages: en", ""].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
}

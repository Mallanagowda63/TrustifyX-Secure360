import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { makeOrg } from "./db";

export const MKT = "http://localhost:3000";
export const PORTAL = "http://portal.localhost:3000";
export const none = { params: Promise.resolve({}) };

/** Per-host cookie jar, like a browser (host-only cookies). */
export class Browser {
  jars = new Map<string, Map<string, string>>();
  jar(origin: string) {
    const host = new URL(origin).host;
    if (!this.jars.has(host)) this.jars.set(host, new Map());
    return this.jars.get(host)!;
  }
  req(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const u = new URL(url);
    const jar = this.jar(u.origin);
    const headers: Record<string, string> = { host: u.host, origin: u.origin, ...extra };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && jar.get("tx_csrf")) headers["x-csrf-token"] = jar.get("tx_csrf")!;
    if (body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  absorb(url: string, res: Response) {
    const jar = this.jar(new URL(url).origin);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v === "") jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
    return res;
  }
  async get(url: string, handler: (r: NextRequest) => Response | Promise<Response>) {
    return this.absorb(url, await handler(this.req("GET", url)));
  }
}

export async function userWithPassword(email: string, password: string, plan: string | null = "GROWTH") {
  const o = await makeOrg("Cust", "OWNER", { plan });
  await prisma.user.update({ where: { id: o.user.id }, data: { email, passwordHash: await hashPassword(password) } });
  return o;
}

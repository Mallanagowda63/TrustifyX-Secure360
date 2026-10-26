import { NextResponse } from "next/server";
import { publicRoute } from "@/server/api";
import { audit } from "@/server/audit";
import { clearSessionCookies } from "@/server/auth/cookies";
import { destroySession, sessionCookieName } from "@/server/auth/session";

export const POST = publicRoute(async ({ req, ip, session }) => {
  await destroySession(req.cookies.get(sessionCookieName())?.value);
  if (session) await audit({ orgId: session.org?.id, userId: session.user.id, ip, action: "auth.logout" });
  return clearSessionCookies(NextResponse.json({ ok: true }));
});

import { NextResponse } from "next/server";
import { env } from "../env";
import { csrfCookieName, sessionCookieName } from "./session";

const secure = () => env().APP_URL.startsWith("https://");

export function withSessionCookies(res: NextResponse, s: { token: string; csrfToken: string; expiresAt: Date }) {
  res.cookies.set(sessionCookieName(), s.token, {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    path: "/",
    expires: s.expiresAt,
  });
  // Readable by the SPA so it can echo it in the X-CSRF-Token header (double-submit).
  res.cookies.set(csrfCookieName(), s.csrfToken, {
    httpOnly: false,
    secure: secure(),
    sameSite: "strict",
    path: "/",
    expires: s.expiresAt,
  });
  return res;
}

export function clearSessionCookies(res: NextResponse) {
  for (const name of [sessionCookieName(), csrfCookieName()]) {
    res.cookies.set(name, "", { httpOnly: name === sessionCookieName(), secure: secure(), path: "/", maxAge: 0 });
  }
  return res;
}

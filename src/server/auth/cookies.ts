import { NextResponse } from "next/server";
import { env } from "../env";
import { csrfCookieName, sessionCookieName } from "./session";

const secure = () => env().APP_URL.startsWith("https://");

export function withSessionCookies(res: NextResponse, s: { token: string; csrfToken: string; expiresAt: Date; persistent?: boolean }) {
  // Without "remember me" the cookies end with the browser session (server-side expiry still applies).
  const expires = s.persistent === false ? undefined : s.expiresAt;
  res.cookies.set(sessionCookieName(), s.token, {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    path: "/",
    expires,
  });
  // Readable by the SPA so it can echo it in the X-CSRF-Token header (double-submit).
  res.cookies.set(csrfCookieName(), s.csrfToken, {
    httpOnly: false,
    secure: secure(),
    sameSite: "strict",
    path: "/",
    expires,
  });
  return res;
}

export function clearSessionCookies(res: NextResponse) {
  for (const name of [sessionCookieName(), csrfCookieName()]) {
    res.cookies.set(name, "", { httpOnly: name === sessionCookieName(), secure: secure(), path: "/", maxAge: 0 });
  }
  return res;
}

/** Pending second-factor sign-in (password already verified). Host-only, HttpOnly, 5 minutes. */
export function mfaChallengeCookieName(): string {
  return env().APP_URL.startsWith("https://") ? "__Host-tx_mfa" : "tx_mfa";
}

export function withMfaChallengeCookie(res: NextResponse, token: string, maxAgeSec: number) {
  res.cookies.set(mfaChallengeCookieName(), token, { httpOnly: true, secure: secure(), sameSite: "strict", path: "/", maxAge: maxAgeSec });
  return res;
}

export function clearMfaChallengeCookie(res: NextResponse) {
  res.cookies.set(mfaChallengeCookieName(), "", { httpOnly: true, secure: secure(), sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}

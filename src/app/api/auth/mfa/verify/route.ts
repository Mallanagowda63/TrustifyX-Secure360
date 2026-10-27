import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { clearMfaChallengeCookie, mfaChallengeCookieName, withSessionCookies } from "@/server/auth/cookies";
import { completeMfaChallenge } from "@/server/auth/mfa";

const body = z
  .object({ code: z.string().max(20).optional(), recoveryCode: z.string().max(40).optional() })
  .refine((b) => Boolean(b.code || b.recoveryCode), { message: "Enter a code" });

/** Second sign-in step: TOTP code or recovery code against the pending challenge cookie. */
export const POST = publicRoute(
  async ({ req, ip, site }) => {
    const input = await readJson(req, body);
    const result = await completeMfaChallenge(req.cookies.get(mfaChallengeCookieName())?.value, input, {
      ip,
      userAgent: req.headers.get("user-agent"),
      site,
    });
    const res = NextResponse.json({ ok: true, method: result.method, recoveryCodesRemaining: result.recoveryCodesRemaining });
    return clearMfaChallengeCookie(withSessionCookies(res, result.session));
  },
  { rateLimit: { key: "mfa-verify", limit: 30, windowSec: 900 } },
);

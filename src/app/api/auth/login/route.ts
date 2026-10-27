import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { clearMfaChallengeCookie, withMfaChallengeCookie, withSessionCookies } from "@/server/auth/cookies";
import { MFA_CHALLENGE_TTL_SEC } from "@/server/auth/mfa";
import { login } from "@/server/services/auth";
import { emailSchema, passwordSchema } from "@/server/validation";

const body = z.object({ email: emailSchema, password: passwordSchema, remember: z.boolean().optional() });

export const POST = publicRoute(
  async ({ req, ip, site }) => {
    const input = await readJson(req, body);
    const result = await login(input, { ip, userAgent: req.headers.get("user-agent"), site, persistent: input.remember ?? true });
    if (result.kind === "mfa") {
      // No session yet: the second step (/api/auth/mfa/verify) reads this HttpOnly cookie.
      return withMfaChallengeCookie(NextResponse.json({ mfaRequired: true }), result.mfaChallenge, MFA_CHALLENGE_TTL_SEC);
    }
    const { user, session, mfaWasReset } = result;
    return clearMfaChallengeCookie(withSessionCookies(NextResponse.json({ user: { id: user.id, email: user.email, name: user.name }, mfaWasReset }), session));
  },
  { rateLimit: { key: "login", limit: 30, windowSec: 900 } },
);

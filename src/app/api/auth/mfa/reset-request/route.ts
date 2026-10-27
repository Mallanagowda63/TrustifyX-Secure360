import { publicRoute } from "@/server/api";
import { mfaChallengeCookieName } from "@/server/auth/cookies";
import { requestMfaReset } from "@/server/auth/mfa";

/** "Lost my authenticator and recovery codes": requires the pending sign-in (password verified). */
export const POST = publicRoute(
  async ({ req, ip, site }) => requestMfaReset(req.cookies.get(mfaChallengeCookieName())?.value, site, ip),
  { rateLimit: { key: "mfa-reset", limit: 10, windowSec: 3600 } },
);

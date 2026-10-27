import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { cancelMfaReset } from "@/server/auth/mfa";

const body = z.object({ token: z.string().min(10).max(100).optional() });

/** Cancels a pending two-factor reset, by emailed link token or from a signed-in session. */
export const POST = publicRoute(
  async ({ req, ip, session }) => {
    const { token } = await readJson(req, body);
    if (token) return cancelMfaReset({ token }, ip);
    if (session) return cancelMfaReset({ userId: session.user.id }, ip);
    return { cancelled: false };
  },
  { rateLimit: { key: "mfa-reset-cancel", limit: 20, windowSec: 3600 } },
);

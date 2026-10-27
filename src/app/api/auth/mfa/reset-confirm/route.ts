import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { confirmMfaReset } from "@/server/auth/mfa";

const body = z.object({ token: z.string().min(10).max(100) });

export const POST = publicRoute(
  async ({ req, ip }) => {
    const { token } = await readJson(req, body);
    return confirmMfaReset(token, ip);
  },
  { rateLimit: { key: "mfa-reset-confirm", limit: 20, windowSec: 3600 } },
);

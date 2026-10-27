import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { requestPasswordReset } from "@/server/auth/password-reset";
import { emailSchema } from "@/server/validation";

export const POST = publicRoute(
  async ({ req, ip }) => {
    const { email } = await readJson(req, z.object({ email: emailSchema }));
    const { message } = await requestPasswordReset(email, ip);
    return { ok: true, message };
  },
  { rateLimit: { key: "forgot-password", limit: 10, windowSec: 900 } },
);

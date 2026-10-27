import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { resetPassword } from "@/server/auth/password-reset";
import { passwordSchema } from "@/server/validation";

export const POST = publicRoute(
  async ({ req, ip }) => {
    const { token, password } = await readJson(req, z.object({ token: z.string().min(20).max(100), password: passwordSchema }));
    await resetPassword(token, password, ip);
    return { ok: true, message: "Your password was changed. Please sign in with your new password." };
  },
  { rateLimit: { key: "reset-password", limit: 10, windowSec: 900 } },
);

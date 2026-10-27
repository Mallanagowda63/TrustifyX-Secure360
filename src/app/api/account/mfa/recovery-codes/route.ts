import { z } from "zod";
import { authedRoute, readJson } from "@/server/api";
import { regenerateRecoveryCodes } from "@/server/auth/mfa";

const body = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(12) });

export const POST = authedRoute(
  null,
  async ({ req, ctx }) => {
    const { password, code } = await readJson(req, body);
    return regenerateRecoveryCodes(ctx.user.id, password, code, ctx.ip);
  },
  { mfaExempt: true },
);

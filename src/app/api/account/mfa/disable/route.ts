import { z } from "zod";
import { authedRoute, readJson } from "@/server/api";
import { disableMfa } from "@/server/auth/mfa";

const body = z
  .object({ password: z.string().min(1).max(200), code: z.string().max(12).optional(), recoveryCode: z.string().max(40).optional() })
  .refine((b) => Boolean(b.code || b.recoveryCode), { message: "Enter a code" });

export const POST = authedRoute(
  null,
  async ({ req, ctx }) => {
    const { password, ...second } = await readJson(req, body);
    await disableMfa(ctx.user.id, password, second, ctx.ip);
    return { ok: true };
  },
  { mfaExempt: true },
);

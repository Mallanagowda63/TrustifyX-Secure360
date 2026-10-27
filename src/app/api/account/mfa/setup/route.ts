import { z } from "zod";
import { authedRoute, readJson } from "@/server/api";
import { beginEnrollment } from "@/server/auth/mfa";

const body = z.object({ password: z.string().min(1).max(200) });

/** Step 1: re-enter password, receive the QR code (secret stored encrypted, not yet active). */
export const POST = authedRoute(
  null,
  async ({ req, ctx }) => {
    const { password } = await readJson(req, body);
    return beginEnrollment(ctx.user.id, password, ctx.ip);
  },
  { mfaExempt: true },
);

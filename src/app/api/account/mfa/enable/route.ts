import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, readJson } from "@/server/api";
import { withSessionCookies } from "@/server/auth/cookies";
import { confirmEnrollment } from "@/server/auth/mfa";
import { rotateSession } from "@/server/auth/session";

const body = z.object({ code: z.string().min(6).max(12) });

/** Step 2: confirm with a code. Other sessions are signed out and this one gets a new token. */
export const POST = authedRoute(
  null,
  async ({ req, ctx }) => {
    const { code } = await readJson(req, body);
    const { recoveryCodes } = await confirmEnrollment(ctx.user.id, code, ctx.ip, ctx.session.id);
    const fresh = await rotateSession(ctx.session);
    return withSessionCookies(NextResponse.json({ recoveryCodes, csrfToken: fresh.csrfToken }), fresh);
  },
  { mfaExempt: true },
);

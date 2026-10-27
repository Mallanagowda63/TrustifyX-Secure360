import { authedRoute } from "@/server/api";
import { mfaStatus } from "@/server/auth/mfa";

export const GET = authedRoute(null, async ({ ctx }) => mfaStatus(ctx.user.id), { mfaExempt: true });

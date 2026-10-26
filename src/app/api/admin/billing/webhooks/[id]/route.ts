import { adminRoute } from "@/server/api";
import { adminReprocessWebhook } from "@/server/billing/admin";

/** Re-runs processing of a stored, signature-verified event (idempotent). */
export const POST = adminRoute<{ id: string }>(async ({ ctx, params }) => adminReprocessWebhook(ctx.user.id, params.id));

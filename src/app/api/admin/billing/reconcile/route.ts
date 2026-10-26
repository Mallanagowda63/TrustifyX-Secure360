import { adminRoute } from "@/server/api";
import { adminReconcile } from "@/server/billing/admin";

export const POST = adminRoute(async ({ ctx }) => ({ stats: await adminReconcile(ctx.user.id) }));

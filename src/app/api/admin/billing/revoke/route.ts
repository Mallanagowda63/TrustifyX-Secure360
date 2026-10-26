import { z } from "zod";
import { adminRoute, readJson } from "@/server/api";
import { adminRevokeComplimentary } from "@/server/billing/admin";

export const POST = adminRoute(async ({ req, ctx }) => {
  const { subscriptionId } = await readJson(req, z.object({ subscriptionId: z.string().min(1).max(64) }).strict());
  await adminRevokeComplimentary(ctx.user.id, subscriptionId);
  return { ok: true };
});

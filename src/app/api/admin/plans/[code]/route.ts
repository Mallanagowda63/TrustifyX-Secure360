import { z } from "zod";
import { adminRoute, readJson } from "@/server/api";
import { adminUpdatePlan, planEditSchema } from "@/server/billing/admin";

const body = z.object({ confirmCode: z.string().max(40), patch: planEditSchema }).strict();

/** Catalog edit (affects new checkouts only). Requires typing the plan code to confirm. */
export const PATCH = adminRoute<{ code: string }>(async ({ req, ctx, params }) => {
  const { confirmCode, patch } = await readJson(req, body);
  return { plan: await adminUpdatePlan(ctx.user.id, params.code.toUpperCase(), patch, confirmCode) };
});

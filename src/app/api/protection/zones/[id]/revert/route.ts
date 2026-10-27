import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { revertFeature } from "@/server/protection/service";

const body = z.object({ feature: z.string().max(60), confirm: z.literal(true) });

/** Removes a TrustifyX-managed rule or restores the previous setting value. */
export const POST = authedRoute<{ id: string }>("protection.manage", async ({ req, ctx, params }) => {
  const { feature } = await readJson(req, body);
  return revertFeature(actorOf(ctx), params.id, feature);
});

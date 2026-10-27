import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { enforceFeature } from "@/server/protection/service";

const body = z.object({ feature: z.string().max(60), confirm: z.literal(true) });

export const POST = authedRoute<{ id: string }>("protection.manage", async ({ req, ctx, params }) => {
  const { feature } = await readJson(req, body);
  return enforceFeature(actorOf(ctx), params.id, feature);
});

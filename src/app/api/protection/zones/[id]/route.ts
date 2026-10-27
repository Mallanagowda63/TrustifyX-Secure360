import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { unlinkZone } from "@/server/protection/service";

const body = z.object({ removeTrustifyxChanges: z.boolean(), confirm: z.literal(true) });

export const DELETE = authedRoute<{ id: string }>("protection.manage", async ({ req, ctx, params }) => {
  const { removeTrustifyxChanges } = await readJson(req, body);
  return unlinkZone(actorOf(ctx), params.id, { removeTrustifyxChanges });
});

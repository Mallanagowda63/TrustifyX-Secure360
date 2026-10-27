import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { disconnectCloudflare } from "@/server/protection/service";

const body = z.object({ removeTrustifyxChanges: z.boolean(), confirm: z.literal(true) });

export const POST = authedRoute("protection.manage", async ({ req, ctx }) => {
  const { removeTrustifyxChanges } = await readJson(req, body);
  return disconnectCloudflare(actorOf(ctx), { removeTrustifyxChanges });
});

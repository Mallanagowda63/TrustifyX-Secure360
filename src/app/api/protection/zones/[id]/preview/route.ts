import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { previewChanges } from "@/server/protection/service";

const body = z.object({ features: z.array(z.string().max(60)).min(1).max(20), mode: z.enum(["enforce", "preview"]).default("enforce") });

/** Step 1 of "Activate Available Protection": shows exactly what would change. Changes nothing. */
export const POST = authedRoute<{ id: string }>("protection.manage", async ({ req, ctx, params }) => {
  const { features, mode } = await readJson(req, body);
  return previewChanges(actorOf(ctx), params.id, features, mode);
});

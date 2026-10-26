import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { explainFinding } from "@/server/ai/assistant";
import { idSchema } from "@/server/validation";

export const POST = authedRoute("ai.use", async ({ req, ctx }) => {
  const { findingId } = await readJson(req, z.object({ findingId: idSchema }));
  return explainFinding(actorOf(ctx), findingId);
});

import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { explainChange } from "@/server/ai/assistant";
import { idSchema } from "@/server/validation";

export const POST = authedRoute("ai.use", async ({ req, ctx }) => {
  const { changeId } = await readJson(req, z.object({ changeId: idSchema }));
  return explainChange(actorOf(ctx), changeId);
});

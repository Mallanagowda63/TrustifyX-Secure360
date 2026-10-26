import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { ask } from "@/server/ai/assistant";
import { idSchema } from "@/server/validation";

const body = z.object({
  question: z.string().trim().min(3).max(2000),
  websiteId: idSchema.optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(12)
    .optional(),
});

export const POST = authedRoute("ai.use", async ({ req, ctx }) => ask(actorOf(ctx), await readJson(req, body)));

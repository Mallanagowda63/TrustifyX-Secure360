import { actorOf, authedRoute } from "@/server/api";
import { prioritize } from "@/server/ai/assistant";

export const POST = authedRoute("ai.use", async ({ ctx }) => prioritize(actorOf(ctx)));

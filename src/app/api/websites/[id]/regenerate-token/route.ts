import { authedRoute, actorOf } from "@/server/api";
import { regenerateVerificationToken } from "@/server/services/websites";

export const POST = authedRoute<{ id: string }>("website.update", async ({ ctx, params }) => ({
  website: await regenerateVerificationToken(actorOf(ctx), params.id),
}));

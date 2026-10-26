import { actorOf, authedRoute } from "@/server/api";
import { revokeInvitation } from "@/server/services/auth";

export const DELETE = authedRoute<{ id: string }>("team.manage", async ({ ctx, params }) => {
  await revokeInvitation(actorOf(ctx), params.id);
  return { ok: true };
});

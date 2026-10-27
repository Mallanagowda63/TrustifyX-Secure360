import { actorOf, authedRoute } from "@/server/api";
import { refreshZone } from "@/server/protection/service";

export const POST = authedRoute<{ id: string }>("protection.read", async ({ ctx, params }) => refreshZone(actorOf(ctx), params.id));

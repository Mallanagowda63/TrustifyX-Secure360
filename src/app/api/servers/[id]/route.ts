import { actorOf, authedRoute } from "@/server/api";
import { removeServer } from "@/server/servers/service";

export const DELETE = authedRoute<{ id: string }>("server.manage", async ({ ctx, params }) => removeServer(actorOf(ctx), params.id));

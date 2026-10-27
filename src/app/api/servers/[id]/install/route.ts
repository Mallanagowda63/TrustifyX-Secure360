import { actorOf, authedRoute } from "@/server/api";
import { installFor } from "@/server/servers/service";

export const GET = authedRoute<{ id: string }>("server.manage", async ({ ctx, params }) => installFor(actorOf(ctx), params.id));

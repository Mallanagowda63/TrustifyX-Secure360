import { authedRoute, actorOf } from "@/server/api";
import { requestScan } from "@/server/services/websites";

export const POST = authedRoute<{ id: string }>("website.scan", async ({ ctx, params }) =>
  requestScan(actorOf(ctx), params.id),
);

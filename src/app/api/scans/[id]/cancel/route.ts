import { actorOf, authedRoute } from "@/server/api";
import { cancelScan } from "@/server/scanning/service";

export const POST = authedRoute<{ id: string }>("scan.manage", async ({ ctx, params }) => cancelScan(actorOf(ctx), params.id));

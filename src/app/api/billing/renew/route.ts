import { actorOf, authedRoute } from "@/server/api";
import { renewSubscription } from "@/server/billing/service";

export const POST = authedRoute("billing.manage", async ({ ctx }) => ({ checkout: await renewSubscription(actorOf(ctx)) }));

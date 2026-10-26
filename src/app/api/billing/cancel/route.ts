import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { cancelSubscription } from "@/server/billing/service";

const body = z.object({ atPeriodEnd: z.boolean().default(true) }).strict();

export const POST = authedRoute("billing.manage", async ({ req, ctx }) => cancelSubscription(actorOf(ctx), await readJson(req, body)));

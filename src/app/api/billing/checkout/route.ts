import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { startCheckout } from "@/server/billing/service";

// Only a plan code and cycle are accepted: amounts are never taken from the client.
const body = z.object({ planCode: z.string().trim().toUpperCase().max(40), cycle: z.enum(["MONTHLY", "ANNUAL"]) }).strict();

export const POST = authedRoute("billing.manage", async ({ req, ctx }) => ({ checkout: await startCheckout(actorOf(ctx), await readJson(req, body)) }));

import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { changePlan } from "@/server/billing/service";

const body = z.object({ planCode: z.string().trim().toUpperCase().max(40), cycle: z.enum(["MONTHLY", "ANNUAL"]) }).strict();

export const POST = authedRoute("billing.manage", async ({ req, ctx }) => ({ checkout: await changePlan(actorOf(ctx), await readJson(req, body)) }));

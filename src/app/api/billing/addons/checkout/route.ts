import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { startAddonCheckout } from "@/server/billing/service";

const body = z.object({ addonCode: z.string().regex(/^[A-Z_]{2,40}$/), cycle: z.enum(["MONTHLY", "ANNUAL"]).default("MONTHLY") }).strict();

export const POST = authedRoute("billing.manage", async ({ req, ctx }) => ({ checkout: await startAddonCheckout(actorOf(ctx), await readJson(req, body)) }));

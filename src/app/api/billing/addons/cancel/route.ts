import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { cancelAddon } from "@/server/billing/service";

const body = z.object({ addonCode: z.string().regex(/^[A-Z_]{2,40}$/), atPeriodEnd: z.boolean().default(true) }).strict();

/** Cancels only the add-on; the base plan continues. */
export const POST = authedRoute("billing.manage", async ({ req, ctx }) => cancelAddon(actorOf(ctx), await readJson(req, body)));

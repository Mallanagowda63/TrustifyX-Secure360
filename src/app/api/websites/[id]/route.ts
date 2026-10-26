import { z } from "zod";
import { authedRoute, readJson, actorOf } from "@/server/api";
import { deleteWebsite, getWebsiteForOrg, presentWebsite, updateWebsite } from "@/server/services/websites";

type P = { id: string };
export const GET = authedRoute<P>("website.read", async ({ ctx, params }) => ({
  website: presentWebsite(await getWebsiteForOrg(ctx.org.id, params.id)),
}));

const patch = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    availabilityIntervalSec: z.number().int().min(30).max(86_400).optional(),
    configIntervalSec: z.number().int().min(3600).max(7 * 86_400).optional(),
    paused: z.boolean().optional(),
  })
  .strict();

export const PATCH = authedRoute<P>("website.update", async ({ req, ctx, params }) => ({
  website: await updateWebsite(actorOf(ctx), params.id, await readJson(req, patch)),
}));

export const DELETE = authedRoute<P>("website.delete", async ({ ctx, params }) => {
  await deleteWebsite(actorOf(ctx), params.id);
  return { ok: true };
});

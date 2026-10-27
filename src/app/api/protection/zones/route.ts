import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { linkZone } from "@/server/protection/service";
import { idSchema } from "@/server/validation";

const body = z.object({ websiteId: idSchema, cfZoneId: z.string().regex(/^[a-f0-9]{32}$/i, "Invalid Cloudflare zone ID") });

/** Link a verified website to the Cloudflare zone that serves it. */
export const POST = authedRoute("protection.manage", async ({ req, ctx }) => {
  const { websiteId, cfZoneId } = await readJson(req, body);
  const zone = await linkZone(actorOf(ctx), websiteId, cfZoneId);
  return { zone: { id: zone.id, name: zone.name, status: zone.status } };
});

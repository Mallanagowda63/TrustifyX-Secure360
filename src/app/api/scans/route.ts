import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { listScans, requestScan, scanUsage } from "@/server/scanning/service";
import { idSchema } from "@/server/validation";

export const GET = authedRoute("scan.read", async ({ ctx }) => ({ ...(await listScans(ctx.org.id)), usage: await scanUsage(ctx.org.id) }));

const body = z.object({
  websiteId: idSchema,
  type: z.enum(["PASSIVE", "ACTIVE"]),
  confirmAuthorization: z.boolean(),
  confirmHostname: z.string().max(253).optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
});

/** Requests an authorized scan of a verified website (queued for the isolated scanner). */
export const POST = authedRoute("scan.manage", async ({ req, ctx }) => {
  const input = await readJson(req, body);
  const scan = await requestScan(actorOf(ctx), input);
  return { scan: { id: scan.id, status: scan.status, type: scan.type } };
});

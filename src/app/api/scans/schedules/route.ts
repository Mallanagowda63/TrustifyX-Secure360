import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { setSchedule } from "@/server/scanning/service";
import { idSchema } from "@/server/validation";

const body = z.object({ websiteId: idSchema, frequency: z.enum(["WEEKLY", "MONTHLY", "OFF"]), confirmAuthorization: z.boolean() });

/** Recurring passive scans only. Active scans always need a new authorization and window. */
export const POST = authedRoute("scan.manage", async ({ req, ctx }) => {
  const input = await readJson(req, body);
  return { schedule: await setSchedule(actorOf(ctx), input) };
});

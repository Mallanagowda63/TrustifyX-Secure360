import { z } from "zod";
import { authedRoute, readJson, actorOf } from "@/server/api";
import { verifyWebsite } from "@/server/services/websites";

const body = z.object({
  method: z.enum(["DNS_TXT", "HTTP_FILE"]),
  // The customer attests they own or are authorized to monitor the property.
  authorizationConfirmed: z.literal(true, { message: "You must confirm you are authorized to monitor this website" }),
});

export const POST = authedRoute<{ id: string }>("website.verify", async ({ req, ctx, params }) => {
  const input = await readJson(req, body);
  return verifyWebsite(actorOf(ctx), params.id, input);
});

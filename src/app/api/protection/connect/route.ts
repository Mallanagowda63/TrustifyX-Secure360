import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { connectCloudflare } from "@/server/protection/service";

const body = z.object({ token: z.string().min(20).max(200) });

/** Connect Cloudflare (or replace the token) with a scoped API token. Verified before it is stored. */
export const POST = authedRoute("protection.manage", async ({ req, ctx }) => {
  const { token } = await readJson(req, body);
  return connectCloudflare(actorOf(ctx), token);
});

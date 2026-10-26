import { actorOf, authedRoute } from "@/server/api";
import { getFinding } from "@/server/services/findings";
import { requestScan } from "@/server/services/websites";

/** Re-runs the checks for the finding's website so a fix can be verified. */
export const POST = authedRoute<{ id: string }>("website.scan", async ({ ctx, params }) => {
  const f = await getFinding(ctx.org.id, params.id);
  return requestScan(actorOf(ctx), f.websiteId);
});

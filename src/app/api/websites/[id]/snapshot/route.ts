import { authedRoute } from "@/server/api";
import { getWebsiteForOrg, latestSnapshot } from "@/server/services/websites";

export const GET = authedRoute<{ id: string }>("website.read", async ({ ctx, params }) => {
  const site = await getWebsiteForOrg(ctx.org.id, params.id);
  return { snapshot: await latestSnapshot(ctx.org.id, site.id) };
});

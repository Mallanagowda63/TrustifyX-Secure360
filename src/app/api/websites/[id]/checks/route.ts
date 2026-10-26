import { authedRoute } from "@/server/api";
import { getWebsiteForOrg, recentChecks } from "@/server/services/websites";

export const GET = authedRoute<{ id: string }>("website.read", async ({ ctx, params }) => {
  const site = await getWebsiteForOrg(ctx.org.id, params.id);
  return { checks: await recentChecks(ctx.org.id, site.id, 100) };
});

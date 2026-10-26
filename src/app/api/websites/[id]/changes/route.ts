import { authedRoute } from "@/server/api";
import { configChanges, getWebsiteForOrg } from "@/server/services/websites";

export const GET = authedRoute<{ id: string }>("website.read", async ({ ctx, params }) => {
  const site = await getWebsiteForOrg(ctx.org.id, params.id);
  return { changes: await configChanges(ctx.org.id, site.id) };
});

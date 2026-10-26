import { z } from "zod";
import { authedRoute } from "@/server/api";
import { availabilitySeries, getWebsiteForOrg } from "@/server/services/websites";

const range = z.enum(["24h", "7d", "30d"]).catch("24h");

export const GET = authedRoute<{ id: string }>("website.read", async ({ req, ctx, params }) => {
  const site = await getWebsiteForOrg(ctx.org.id, params.id);
  return availabilitySeries(ctx.org.id, site.id, range.parse(req.nextUrl.searchParams.get("range")));
});

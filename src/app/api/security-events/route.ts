import { ApiError, authedRoute } from "@/server/api";
import { eventSummary } from "@/server/protection/events";
import { protectionAccess } from "@/server/protection/service";
import { idSchema } from "@/server/validation";

export const GET = authedRoute("protection.read", async ({ req, ctx }) => {
  const access = await protectionAccess(ctx.org.id);
  if (!access.protect) throw new ApiError(402, "Security event dashboards require the Secure360 Protect add-on.", "protect_required");
  const zone = req.nextUrl.searchParams.get("zone");
  const days = Number(req.nextUrl.searchParams.get("days") ?? 7);
  return eventSummary(ctx.org.id, { zoneRefId: zone ? idSchema.parse(zone) : undefined, days: Number.isFinite(days) ? days : 7 });
});

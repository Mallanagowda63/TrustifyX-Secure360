import { actorOf, authedRoute } from "@/server/api";
import { syncOrgBilling } from "@/server/billing/service";
import { rateLimit } from "@/server/security/rate-limit";
import { ApiError } from "@/server/api";

export const POST = authedRoute("billing.manage", async ({ ctx }) => {
  const rl = await rateLimit(`billing-sync:${ctx.org.id}`, 10, 600);
  if (!rl.allowed) throw new ApiError(429, "Please wait before refreshing billing status again.", "rate_limited");
  return syncOrgBilling(actorOf(ctx));
});

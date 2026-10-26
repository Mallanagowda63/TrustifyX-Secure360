import { authedRoute } from "@/server/api";
import { billingOverview } from "@/server/billing/service";

export const GET = authedRoute("billing.read", async ({ ctx }) => billingOverview(ctx.org.id));

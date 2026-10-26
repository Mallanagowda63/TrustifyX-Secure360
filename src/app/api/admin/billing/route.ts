import { adminRoute } from "@/server/api";
import { adminBillingOverview } from "@/server/billing/admin";

export const GET = adminRoute(async () => adminBillingOverview());

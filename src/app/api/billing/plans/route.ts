import { publicRoute } from "@/server/api";
import { listPlans, presentPlan } from "@/server/billing/plans";
import { annualEnabled } from "@/server/billing/plans";

/** Public catalog. Prices come from the database; checkout re-reads them server-side. */
export const GET = publicRoute(async () => ({
  plans: (await listPlans()).map(presentPlan),
  annualEnabled: annualEnabled(),
}));

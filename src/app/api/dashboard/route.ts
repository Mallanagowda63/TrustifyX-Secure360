import { authedRoute } from "@/server/api";
import { dashboardData } from "@/server/services/dashboard";

export const GET = authedRoute("website.read", async ({ ctx }) => dashboardData(ctx.org.id));

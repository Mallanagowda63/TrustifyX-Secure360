import { authedRoute } from "@/server/api";
import { listAlerts } from "@/server/services/dashboard";

export const GET = authedRoute("alert.read", async ({ ctx }) => ({ alerts: await listAlerts(ctx.org.id) }));

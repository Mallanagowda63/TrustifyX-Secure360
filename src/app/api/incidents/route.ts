import { authedRoute } from "@/server/api";
import { listIncidents } from "@/server/services/dashboard";

export const GET = authedRoute("alert.read", async ({ ctx }) => ({ incidents: await listIncidents(ctx.org.id) }));

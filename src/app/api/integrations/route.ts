import { authedRoute } from "@/server/api";
import { listIntegrations } from "@/server/integrations/catalog";

export const GET = authedRoute("integration.read", async ({ ctx }) => ({ integrations: await listIntegrations(ctx.org.id) }));

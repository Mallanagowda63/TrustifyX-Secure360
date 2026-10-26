import { authedRoute } from "@/server/api";
import { requireFeature } from "@/server/billing/entitlements";
import { listAuditLogs } from "@/server/services/dashboard";

export const GET = authedRoute("audit.read", async ({ ctx }) => {
  await requireFeature(ctx.org.id, "auditLogs");
  return { logs: await listAuditLogs(ctx.org.id) };
});

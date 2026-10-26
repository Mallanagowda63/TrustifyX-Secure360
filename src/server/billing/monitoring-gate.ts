import { prisma } from "../db";
import { enqueueFullScan } from "../queue";
import { closeOpenDowntime } from "../monitoring/incidents";
import { getEntitlement } from "./entitlements";

/**
 * Aligns which verified websites are monitored with the organization's entitlement.
 *
 * Monitoring runs only when ALL of these hold: active paid entitlement, verified ownership,
 * and the customer's authorization. Billing never deletes websites or history:
 *  - no entitlement            → verified sites paused (SUBSCRIPTION_INACTIVE)
 *  - entitlement, over limit   → oldest sites keep their slots, the rest pause (PLAN_LIMIT)
 *  - entitlement restored      → sites paused by billing resume automatically
 * Sites the customer paused themselves (USER) are never auto-resumed but keep their slot.
 */
export async function reconcileOrgMonitoring(orgId: string) {
  const ent = await getEntitlement(orgId);
  const sites = await prisma.website.findMany({
    where: { orgId, status: { in: ["CONNECTED", "MONITORING_PAUSED"] }, verifiedAt: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const resumed: string[] = [];
  const paused: string[] = [];

  const pause = async (id: string, reason: "SUBSCRIPTION_INACTIVE" | "PLAN_LIMIT") => {
    await prisma.website.update({ where: { id }, data: { status: "MONITORING_PAUSED", pausedReason: reason, state: "UNKNOWN" } });
    await closeOpenDowntime(id, reason === "PLAN_LIMIT" ? "plan website limit reached" : "subscription inactive");
    paused.push(id);
  };

  let used = 0;
  for (const site of sites) {
    const userPaused = site.status === "MONITORING_PAUSED" && (site.pausedReason === "USER" || site.pausedReason === null);
    if (!ent.active) {
      if (site.status === "CONNECTED") await pause(site.id, "SUBSCRIPTION_INACTIVE");
      else if (!userPaused && site.pausedReason !== "SUBSCRIPTION_INACTIVE") {
        await prisma.website.update({ where: { id: site.id }, data: { pausedReason: "SUBSCRIPTION_INACTIVE" } });
      }
      continue;
    }
    if (userPaused) {
      used++;
      continue;
    }
    if (used < ent.limits.websites && site.authorizationConfirmedAt) {
      used++;
      if (site.status !== "CONNECTED") {
        await prisma.website.update({ where: { id: site.id }, data: { status: "CONNECTED", pausedReason: null } });
        resumed.push(site.id);
      }
    } else if (site.status === "CONNECTED" || site.pausedReason !== "PLAN_LIMIT") {
      await pause(site.id, "PLAN_LIMIT");
    }
  }

  for (const id of resumed) await enqueueFullScan(id).catch(() => undefined);
  return { active: ent.active, resumed, paused };
}

/** Runs the reconciliation for every organization that has verified websites. */
export async function reconcileAllMonitoring() {
  const orgs = await prisma.website.findMany({
    where: { verifiedAt: { not: null }, status: { in: ["CONNECTED", "MONITORING_PAUSED"] } },
    distinct: ["orgId"],
    select: { orgId: true },
  });
  let resumed = 0;
  let paused = 0;
  for (const { orgId } of orgs) {
    const r = await reconcileOrgMonitoring(orgId);
    resumed += r.resumed.length;
    paused += r.paused.length;
  }
  return { orgs: orgs.length, resumed, paused };
}

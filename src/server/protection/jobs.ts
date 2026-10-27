import { prisma } from "../db";
import { env } from "../env";
import { protectionAccess, syncZone } from "./service";
import { syncZoneEvents } from "./events";

/**
 * Periodic Cloudflare synchronisation (worker, every 15 minutes): re-reads configuration and
 * imports new security events for zones of organizations with an active Protect add-on.
 * Zones are processed one at a time so one organization cannot starve the others.
 */
export async function syncAllProtection() {
  const zones = await prisma.cloudflareZone.findMany({
    where: { connection: { status: "ACTIVE" } },
    select: { id: true, orgId: true },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });
  const access = new Map<string, boolean>();
  let synced = 0;
  let failed = 0;
  for (const z of zones) {
    if (!access.has(z.orgId)) access.set(z.orgId, (await protectionAccess(z.orgId)).protect);
    if (!access.get(z.orgId)) continue;
    try {
      await syncZone(z.id);
      await syncZoneEvents(z.id);
      synced++;
    } catch {
      failed++; // recorded on the zone row (lastSyncError / eventsError)
    }
  }
  return { synced, failed };
}

/** Retention control for imported edge events. */
export async function purgeOldSecurityEvents() {
  const cutoff = new Date(Date.now() - env().SECURITY_EVENT_RETENTION_DAYS * 86_400_000);
  return (await prisma.securityEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } })).count;
}

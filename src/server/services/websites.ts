import { Prisma, type VerificationMethod, type Website } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { audit } from "../audit";
import { ApiError, notFound } from "../api";
import { randomToken } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { normalizeWebsiteUrl, UrlValidationError } from "../security/url";
import { enqueueFullScan } from "../queue";
import { closeOpenDowntime } from "../monitoring/incidents";
import { verificationInstructions, verifyDnsTxt, verifyHttpFile, type VerificationResult } from "../websites/verification";
import { assertCan, type Actor } from "./actor";
import { requireEntitlement } from "../billing/entitlements";
import { reconcileOrgMonitoring } from "../billing/monitoring-gate";

/** Tenant-scoped lookup. A website from another organization is indistinguishable from a missing one. */
export async function getWebsiteForOrg(orgId: string, id: string): Promise<Website> {
  const site = await prisma.website.findFirst({ where: { id, orgId } });
  if (!site) throw notFound("Website");
  return site;
}

/** Public representation: never exposes internal fields beyond what the dashboard needs. */
export function presentWebsite(site: Website) {
  return {
    id: site.id,
    displayName: site.displayName,
    url: site.url,
    hostname: site.hostname,
    status: site.status,
    pausedReason: site.pausedReason,
    state: site.state,
    verificationMethod: site.verificationMethod,
    verifiedAt: site.verifiedAt,
    lastVerificationAt: site.lastVerificationAt,
    lastVerificationError: site.lastVerificationError,
    authorizationConfirmedAt: site.authorizationConfirmedAt,
    availabilityIntervalSec: site.availabilityIntervalSec,
    configIntervalSec: site.configIntervalSec,
    lastAvailabilityCheckAt: site.lastAvailabilityCheckAt,
    lastConfigCheckAt: site.lastConfigCheckAt,
    lastResponseTimeMs: site.lastResponseTimeMs,
    lastStatusCode: site.lastStatusCode,
    consecutiveFailures: site.consecutiveFailures,
    tlsValidTo: site.tlsValidTo,
    createdAt: site.createdAt,
    // The customer keeps the record/file in place; it is re-checked daily.
    verification: verificationInstructions(site.hostname, site.verificationToken),
  };
}

export async function listWebsites(orgId: string) {
  const sites = await prisma.website.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });
  return sites.map(presentWebsite);
}

export async function createWebsite(actor: Actor, input: { url: string; displayName?: string }) {
  assertCan(actor, "website.create");
  let normalized;
  try {
    normalized = normalizeWebsiteUrl(input.url);
  } catch (err) {
    if (err instanceof UrlValidationError) throw new ApiError(400, err.message, "invalid_url");
    throw err;
  }
  // Websites can only be added under an active plan, within its limit (all statuses count,
  // including sites paused after a downgrade, so nothing is deleted to make room).
  const ent = await requireEntitlement(actor.orgId);
  const limit = Math.min(ent.limits.websites, env().MAX_WEBSITES_PER_ORG);
  const count = await prisma.website.count({ where: { orgId: actor.orgId } });
  if (count >= limit) {
    throw new ApiError(
      400,
      `Your ${ent.plan?.name ?? ""} plan allows up to ${limit} website${limit === 1 ? "" : "s"}. Remove a website or upgrade your plan.`,
      "plan_limit",
    );
  }
  try {
    const site = await prisma.website.create({
      data: {
        orgId: actor.orgId,
        url: normalized.url,
        hostname: normalized.hostname,
        displayName: (input.displayName?.trim() || normalized.hostname).slice(0, 100),
        verificationToken: randomToken(32),
      },
    });
    await audit({
      orgId: actor.orgId,
      userId: actor.userId,
      ip: actor.ip,
      action: "website.create",
      targetType: "website",
      targetId: site.id,
      metadata: { hostname: site.hostname },
    });
    return presentWebsite(site);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ApiError(409, "This website has already been added to your organization", "duplicate");
    }
    throw err;
  }
}

export interface VerifyDeps {
  dns?: (hostname: string, token: string) => Promise<VerificationResult>;
  file?: (hostname: string, token: string) => Promise<VerificationResult>;
  enqueue?: (websiteId: string) => Promise<void>;
}

export async function verifyWebsite(
  actor: Actor,
  id: string,
  input: { method: VerificationMethod; authorizationConfirmed: boolean },
  deps: VerifyDeps = {},
) {
  assertCan(actor, "website.verify");
  const site = await getWebsiteForOrg(actor.orgId, id);
  if (!input.authorizationConfirmed) {
    throw new ApiError(400, "You must confirm you are authorized to monitor this website", "authorization_required");
  }
  await requireEntitlement(actor.orgId);
  const rl = await rateLimit(`verify:${site.id}`, 10, 3600);
  if (!rl.allowed) throw new ApiError(429, `Too many verification attempts. Try again in ${Math.ceil(rl.retryAfterSec / 60)} minute(s).`, "rate_limited");

  const result =
    input.method === "DNS_TXT"
      ? await (deps.dns ?? verifyDnsTxt)(site.hostname, site.verificationToken)
      : await (deps.file ?? verifyHttpFile)(site.hostname, site.verificationToken);
  const now = new Date();

  if (!result.ok) {
    const updated = await prisma.website.update({
      where: { id: site.id },
      data: {
        // A previously connected site that fails a manual re-check keeps its status.
        status: site.status === "CONNECTED" || site.status === "MONITORING_PAUSED" ? site.status : "VERIFICATION_FAILED",
        lastVerificationAt: now,
        lastVerificationError: result.detail,
      },
    });
    await audit({
      orgId: actor.orgId,
      userId: actor.userId,
      ip: actor.ip,
      action: "website.verify_failed",
      targetType: "website",
      targetId: site.id,
      metadata: { method: input.method, detail: result.detail },
    });
    return { verified: false, detail: result.detail, website: presentWebsite(updated) };
  }

  await prisma.website.update({
    where: { id: site.id },
    data: {
      status: "CONNECTED",
      pausedReason: null,
      verificationMethod: input.method,
      verifiedAt: site.verifiedAt ?? now,
      lastVerificationAt: now,
      lastReverifiedAt: now,
      reverifyFailures: 0,
      lastVerificationError: null,
      authorizationConfirmedAt: now,
      authorizedById: actor.userId,
    },
  });
  await audit({
    orgId: actor.orgId,
    userId: actor.userId,
    ip: actor.ip,
    action: "website.verified",
    targetType: "website",
    targetId: site.id,
    metadata: { method: input.method, hostname: site.hostname, authorizationConfirmed: true },
  });
  // Monitoring starts only if the plan has a free monitoring slot (otherwise paused: PLAN_LIMIT).
  await reconcileOrgMonitoring(actor.orgId);
  const updated = await prisma.website.findUniqueOrThrow({ where: { id: site.id } });
  if (updated.status === "CONNECTED") {
    try {
      await (deps.enqueue ?? enqueueFullScan)(site.id);
    } catch (err) {
      // The scheduler picks the site up within a minute even if the queue is briefly unavailable.
      console.error("[websites] failed to enqueue initial scan", (err as Error).message);
    }
  }
  return { verified: true, detail: result.detail, website: presentWebsite(updated) };
}

export async function updateWebsite(
  actor: Actor,
  id: string,
  input: { displayName?: string; availabilityIntervalSec?: number; configIntervalSec?: number; paused?: boolean },
) {
  assertCan(actor, "website.update");
  const site = await getWebsiteForOrg(actor.orgId, id);
  const data: Prisma.WebsiteUpdateInput = {};
  if (input.displayName !== undefined) data.displayName = input.displayName.trim().slice(0, 100) || site.hostname;
  if (input.availabilityIntervalSec !== undefined) {
    const ent = await requireEntitlement(actor.orgId);
    const min = Math.max(env().MONITOR_MIN_INTERVAL_SEC, ent.limits.availabilityIntervalSec);
    if (input.availabilityIntervalSec < min) {
      throw new ApiError(400, `Availability interval must be at least ${Math.round(min / 60)} minute(s) on your plan`);
    }
    data.availabilityIntervalSec = input.availabilityIntervalSec;
  }
  if (input.configIntervalSec !== undefined) data.configIntervalSec = input.configIntervalSec;
  if (input.paused !== undefined) {
    if (input.paused) {
      if (site.status !== "CONNECTED") throw new ApiError(400, "Only connected websites can be paused");
      data.status = "MONITORING_PAUSED";
      data.pausedReason = "USER";
      data.state = "UNKNOWN";
    } else {
      if (site.status !== "MONITORING_PAUSED") throw new ApiError(400, "Website is not paused");
      if (!site.verifiedAt || !site.authorizationConfirmedAt) throw new ApiError(400, "Website must be verified first");
      const ent = await requireEntitlement(actor.orgId);
      const monitored = await prisma.website.count({
        where: { orgId: actor.orgId, id: { not: site.id }, OR: [{ status: "CONNECTED" }, { status: "MONITORING_PAUSED", pausedReason: "USER" }, { status: "MONITORING_PAUSED", pausedReason: null }] },
      });
      if (monitored >= ent.limits.websites) {
        throw new ApiError(400, `Your plan monitors up to ${ent.limits.websites} website(s). Pause or remove another website, or upgrade.`, "plan_limit");
      }
      data.status = "CONNECTED";
      data.pausedReason = null;
    }
  }
  const updated = await prisma.website.update({ where: { id: site.id }, data });
  if (input.paused === true) await closeOpenDowntime(site.id, "monitoring paused");
  await audit({
    orgId: actor.orgId,
    userId: actor.userId,
    ip: actor.ip,
    action: input.paused === true ? "website.pause" : input.paused === false ? "website.resume" : "website.update",
    targetType: "website",
    targetId: site.id,
    metadata: input,
  });
  if (input.paused === false) await enqueueFullScan(site.id).catch(() => undefined);
  return presentWebsite(updated);
}

export async function deleteWebsite(actor: Actor, id: string) {
  assertCan(actor, "website.delete");
  const site = await getWebsiteForOrg(actor.orgId, id);
  await prisma.website.delete({ where: { id: site.id } });
  await audit({
    orgId: actor.orgId,
    userId: actor.userId,
    ip: actor.ip,
    action: "website.delete",
    targetType: "website",
    targetId: site.id,
    metadata: { hostname: site.hostname },
  });
}

export async function regenerateVerificationToken(actor: Actor, id: string) {
  assertCan(actor, "website.update");
  const site = await getWebsiteForOrg(actor.orgId, id);
  if (site.status === "CONNECTED") {
    throw new ApiError(400, "Pause monitoring before regenerating the token of a connected website");
  }
  const updated = await prisma.website.update({
    where: { id: site.id },
    data: { verificationToken: randomToken(32), status: "PENDING_VERIFICATION", verificationMethod: null, verifiedAt: null },
  });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "website.token_regenerated", targetType: "website", targetId: site.id });
  return presentWebsite(updated);
}

export async function requestScan(actor: Actor, id: string, enqueue = enqueueFullScan) {
  assertCan(actor, "website.scan");
  const site = await getWebsiteForOrg(actor.orgId, id);
  if (site.status !== "CONNECTED") throw new ApiError(400, "Only verified, connected websites can be scanned", "not_connected");
  await requireEntitlement(actor.orgId);
  const cooldown = env().MONITOR_MANUAL_SCAN_COOLDOWN_SEC * 1000;
  if (site.lastManualScanAt && Date.now() - site.lastManualScanAt.getTime() < cooldown) {
    const wait = Math.ceil((cooldown - (Date.now() - site.lastManualScanAt.getTime())) / 1000);
    throw new ApiError(429, `A scan was requested recently. Try again in ${wait} seconds.`, "cooldown");
  }
  await prisma.website.update({ where: { id: site.id }, data: { lastManualScanAt: new Date() } });
  await enqueue(site.id);
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "website.scan_requested", targetType: "website", targetId: site.id });
  return { queued: true };
}

export type Range = "24h" | "7d" | "30d";
const RANGE_CFG: Record<Range, { ms: number; bucket: string }> = {
  "24h": { ms: 24 * 3600_000, bucket: "15 minutes" },
  "7d": { ms: 7 * 86_400_000, bucket: "2 hours" },
  "30d": { ms: 30 * 86_400_000, bucket: "6 hours" },
};

export async function availabilitySeries(orgId: string, websiteId: string | null, range: Range) {
  const cfg = RANGE_CFG[range];
  const since = new Date(Date.now() - cfg.ms);
  const siteFilter = websiteId ? Prisma.sql`AND "websiteId" = ${websiteId}` : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; total: number; up: number; avg_ms: number | null }>>`
    SELECT date_bin(${cfg.bucket}::interval, "checkedAt", TIMESTAMP '2000-01-01') AS bucket,
           count(*)::int AS total,
           sum(CASE WHEN success THEN 1 ELSE 0 END)::int AS up,
           avg("responseTimeMs")::int AS avg_ms
    FROM "AvailabilityCheck"
    WHERE "orgId" = ${orgId} ${siteFilter} AND "checkedAt" >= ${since}
    GROUP BY 1 ORDER BY 1`;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const up = rows.reduce((a, r) => a + r.up, 0);
  return {
    range,
    uptimePercent: total ? Math.round((up / total) * 10000) / 100 : null,
    checks: total,
    points: rows.map((r) => ({
      t: r.bucket.toISOString(),
      uptime: r.total ? Math.round((r.up / r.total) * 10000) / 100 : null,
      avgResponseMs: r.avg_ms,
      checks: r.total,
    })),
  };
}

export async function recentChecks(orgId: string, websiteId: string, take = 50) {
  return prisma.availabilityCheck.findMany({
    where: { orgId, websiteId },
    orderBy: { checkedAt: "desc" },
    take,
    select: { id: true, checkedAt: true, success: true, statusCode: true, responseTimeMs: true, redirectCount: true, finalUrl: true, attempts: true, error: true },
  });
}

export async function configChanges(orgId: string, websiteId: string | null, take = 100) {
  return prisma.configChange.findMany({
    where: { orgId, ...(websiteId ? { websiteId } : {}) },
    orderBy: { detectedAt: "desc" },
    take,
    include: { website: { select: { displayName: true, hostname: true } } },
  });
}

export async function latestSnapshot(orgId: string, websiteId: string) {
  return prisma.configSnapshot.findFirst({ where: { orgId, websiteId }, orderBy: { checkedAt: "desc" } });
}

import type { Prisma, Website } from "@prisma/client";
import { prisma } from "../db";
import { getEntitlement } from "../billing/entitlements";
import { reconcileOrgMonitoring } from "../billing/monitoring-gate";
import { env } from "../env";
import { safeFetch, SafeFetchError } from "../security/safe-fetch";
import { checkAvailability, type AvailabilityResult } from "./availability";
import { checkTls } from "./tls";
import { analyzeHeaders } from "./headers";
import { checkHttpsEnforcement } from "./https";
import { collectDns } from "./dns";
import { diffObservations } from "./diff";
import type { ConfigObservation } from "./types";
import { evaluateRules, evaluatedCategories } from "../findings/rules";
import { reconcileFindings } from "../findings/engine";
import {
  alertDowntime,
  alertFindingOpened,
  alertFindingResolved,
  alertRecovery,
  alertTlsExpiry,
} from "../alerts/events";

/** Monitoring is only ever performed against verified properties the customer authorised. */
export function isMonitorable(site: Pick<Website, "status" | "verifiedAt" | "authorizationConfirmedAt">): boolean {
  return site.status === "CONNECTED" && Boolean(site.verifiedAt) && Boolean(site.authorizationConfirmedAt);
}

export { closeOpenDowntime } from "./incidents";

export interface AvailabilityDeps {
  check?: (url: string) => Promise<AvailabilityResult>;
}

/** Monitoring requires an active paid (or complimentary) entitlement in addition to verification. */
async function entitled(orgId: string): Promise<boolean> {
  if ((await getEntitlement(orgId)).active) return true;
  await reconcileOrgMonitoring(orgId);
  return false;
}

export async function runAvailabilityCheck(websiteId: string, deps: AvailabilityDeps = {}) {
  const site = await prisma.website.findUnique({ where: { id: websiteId } });
  if (!site || !isMonitorable(site)) return { skipped: true as const };
  if (!(await entitled(site.orgId))) return { skipped: true as const };

  const r = await (deps.check ?? checkAvailability)(site.url);
  const now = new Date();

  await prisma.availabilityCheck.create({
    data: {
      websiteId: site.id,
      orgId: site.orgId,
      checkedAt: now,
      success: r.success,
      statusCode: r.statusCode,
      responseTimeMs: r.responseTimeMs,
      redirectCount: r.redirectCount,
      finalUrl: r.finalUrl?.slice(0, 2000),
      attempts: r.attempts,
      error: r.error,
    },
  });

  const common = {
    lastAvailabilityCheckAt: now,
    lastResponseTimeMs: r.responseTimeMs,
    lastStatusCode: r.statusCode,
  };

  if (r.success) {
    // Conditional transition DOWN → UP so concurrent runs cannot both send a recovery.
    const recovered = await prisma.website.updateMany({
      where: { id: site.id, state: "DOWN" },
      data: { ...common, state: "UP", consecutiveFailures: 0 },
    });
    if (recovered.count === 0) {
      await prisma.website.update({ where: { id: site.id }, data: { ...common, state: "UP", consecutiveFailures: 0 } });
    } else {
      const open = await prisma.incident.findMany({
        where: { websiteId: site.id, type: "DOWNTIME", resolvedAt: null },
      });
      for (const inc of open) {
        const resolved = await prisma.incident.update({ where: { id: inc.id }, data: { resolvedAt: now } });
        await alertRecovery(site, resolved);
      }
    }
    return { success: true, state: "UP" as const, transitioned: recovered.count > 0 };
  }

  const updated = await prisma.website.update({
    where: { id: site.id },
    data: { ...common, consecutiveFailures: { increment: 1 } },
  });
  if (updated.consecutiveFailures >= env().MONITOR_DOWN_THRESHOLD) {
    const wentDown = await prisma.website.updateMany({
      where: { id: site.id, state: { not: "DOWN" } },
      data: { state: "DOWN" },
    });
    if (wentDown.count === 1) {
      const existing = await prisma.incident.findFirst({
        where: { websiteId: site.id, type: "DOWNTIME", resolvedAt: null },
      });
      const incident =
        existing ??
        (await prisma.incident.create({
          data: {
            orgId: site.orgId,
            websiteId: site.id,
            type: "DOWNTIME",
            startedAt: now,
            details: { firstError: r.error, statusCode: r.statusCode, consecutiveFailures: updated.consecutiveFailures },
          },
        }));
      await alertDowntime(site, incident, r.error);
      return { success: false, state: "DOWN" as const, transitioned: true };
    }
    return { success: false, state: "DOWN" as const, transitioned: false };
  }
  return { success: false, state: site.state, transitioned: false };
}

function errMsg(err: unknown): string {
  if (err instanceof SafeFetchError) return `${err.code}: ${err.message}`;
  return ((err as Error)?.message ?? String(err)).slice(0, 500);
}

/** Collects every externally observable configuration signal. Each part fails independently. */
export async function collectConfiguration(site: Pick<Website, "hostname" | "url">): Promise<ConfigObservation> {
  const [tls, page, https, dnsInfo] = await Promise.allSettled([
    checkTls(site.hostname),
    safeFetch(site.url, { method: "GET", maxBodyBytes: 256 * 1024 }),
    checkHttpsEnforcement(site.hostname),
    collectDns(site.hostname),
  ]);
  const errors: ConfigObservation["errors"] = {};
  const obs: ConfigObservation = { tls: null, headers: null, https: null, dns: null, errors };

  if (tls.status === "fulfilled") obs.tls = tls.value;
  else errors.tls = errMsg(tls.reason);

  if (page.status === "fulfilled") {
    if (page.value.url.startsWith("https://") && page.value.status < 500) {
      obs.headers = analyzeHeaders(page.value.url, page.value.status, page.value.headers);
    } else {
      errors.headers = page.value.url.startsWith("https://")
        ? `Server returned HTTP ${page.value.status}; headers not evaluated`
        : "Final response was not served over HTTPS; headers not evaluated";
    }
  } else errors.headers = errMsg(page.reason);

  if (https.status === "fulfilled") obs.https = https.value;
  else errors.https = errMsg(https.reason);

  if (dnsInfo.status === "fulfilled") obs.dns = dnsInfo.value;
  else errors.dns = errMsg(dnsInfo.reason);

  return obs;
}

export interface ConfigDeps {
  collect?: (site: Website) => Promise<ConfigObservation>;
}

export async function runConfigCheck(websiteId: string, deps: ConfigDeps = {}) {
  const site = await prisma.website.findUnique({ where: { id: websiteId } });
  if (!site || !isMonitorable(site)) return { skipped: true as const };
  if (!(await entitled(site.orgId))) return { skipped: true as const };

  const observation = await (deps.collect ?? collectConfiguration)(site);
  const now = new Date();

  const prevSnap = await prisma.configSnapshot.findFirst({
    where: { websiteId: site.id },
    orderBy: { checkedAt: "desc" },
  });
  const prev: ConfigObservation | null = prevSnap
    ? {
        tls: prevSnap.tls as unknown as ConfigObservation["tls"],
        headers: prevSnap.headers as unknown as ConfigObservation["headers"],
        https: prevSnap.https as unknown as ConfigObservation["https"],
        dns: prevSnap.dns as unknown as ConfigObservation["dns"],
        errors: (prevSnap.errors ?? {}) as ConfigObservation["errors"],
      }
    : null;

  const json = (v: unknown) => (v === null ? undefined : (v as Prisma.InputJsonValue));
  await prisma.configSnapshot.create({
    data: {
      websiteId: site.id,
      orgId: site.orgId,
      checkedAt: now,
      tls: json(observation.tls),
      headers: json(observation.headers),
      https: json(observation.https),
      dns: json(observation.dns),
      errors: observation.errors as Prisma.InputJsonValue,
    },
  });

  const changes = diffObservations(prev, observation);
  if (changes.length) {
    await prisma.configChange.createMany({
      data: changes.map((c) => ({ ...c, websiteId: site.id, orgId: site.orgId, detectedAt: now })),
    });
  }

  const findingChanges = await reconcileFindings(prisma, {
    orgId: site.orgId,
    websiteId: site.id,
    observations: evaluateRules(observation, site.hostname, now),
    evaluatedCategories: evaluatedCategories(observation),
    now,
  });

  await prisma.website.update({
    where: { id: site.id },
    data: {
      lastConfigCheckAt: now,
      ...(observation.tls ? { tlsValidTo: new Date(observation.tls.validTo) } : {}),
    },
  });

  // TLS expiry notifications and the expired-certificate incident.
  if (observation.tls) {
    await alertTlsExpiry(site, observation.tls);
    const openTls = await prisma.incident.findFirst({
      where: { websiteId: site.id, type: "TLS_EXPIRY", resolvedAt: null },
    });
    if (observation.tls.expired && !openTls) {
      await prisma.incident.create({
        data: {
          orgId: site.orgId,
          websiteId: site.id,
          type: "TLS_EXPIRY",
          startedAt: now,
          details: { validTo: observation.tls.validTo, fingerprint256: observation.tls.fingerprint256 },
        },
      });
    } else if (!observation.tls.expired && openTls) {
      await prisma.incident.update({ where: { id: openTls.id }, data: { resolvedAt: now } });
    }
  }

  for (const f of findingChanges.opened) await alertFindingOpened(site, f, false);
  for (const f of findingChanges.reopened) await alertFindingOpened(site, f, true);
  for (const f of findingChanges.resolved) await alertFindingResolved(site, f);

  return {
    changes: changes.length,
    opened: findingChanges.opened.length,
    reopened: findingChanges.reopened.length,
    resolved: findingChanges.resolved.length,
    errors: observation.errors,
  };
}

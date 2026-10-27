import type { Severity, Website } from "@prisma/client";
import { prisma } from "../db";
import { getEntitlement, type Entitlement } from "../billing/entitlements";
import { availabilitySeries } from "./websites";
import { aggregatePosture, postureScore, type PostureScore } from "./posture";
import type { ConfigObservation } from "../monitoring/types";

export type AccessState = "ACTIVE" | "GRACE" | "CANCELLING" | "COMPLIMENTARY" | "PAYMENT_PENDING" | "SUBSCRIPTION_REQUIRED";

export interface AccessStatus {
  state: AccessState;
  active: boolean;
  label: string;
  planName: string | null;
  accessUntil: Date | null;
  limits: Entitlement["limits"];
  websitesUsed: number;
}

const LABEL: Record<AccessState, string> = {
  ACTIVE: "Subscription Active",
  GRACE: "Payment Overdue · Grace Period",
  CANCELLING: "Subscription Ends at Period End",
  COMPLIMENTARY: "Complimentary Access",
  PAYMENT_PENDING: "Payment Confirmation Pending",
  SUBSCRIPTION_REQUIRED: "Subscription Required",
};

/** Portal access derived only from backend subscription records (never from a redirect/success page). */
export async function accessStatus(orgId: string): Promise<AccessStatus> {
  const [ent, websitesUsed, pending] = await Promise.all([
    getEntitlement(orgId),
    prisma.website.count({ where: { orgId } }),
    prisma.subscription.findFirst({
      where: { orgId, status: "PENDING_PAYMENT", createdAt: { gt: new Date(Date.now() - 48 * 3600_000) } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  let state: AccessState;
  if (ent.active) state = ent.state === "NONE" ? "ACTIVE" : ent.state;
  else state = pending && !pending.scheduledStartAt ? "PAYMENT_PENDING" : "SUBSCRIPTION_REQUIRED";
  return { state, active: ent.active, label: LABEL[state], planName: ent.plan?.name ?? null, accessUntil: ent.accessUntil, limits: ent.limits, websitesUsed };
}

export type SiteIndicator =
  | "WEBSITE_ONLINE"
  | "WEBSITE_OFFLINE"
  | "MONITORING_ACTIVE"
  | "VERIFICATION_REQUIRED"
  | "SUBSCRIPTION_INACTIVE"
  | "INITIAL_SCAN_RUNNING"
  | "SECURITY_FINDING_DETECTED"
  | "MONITORING_PAUSED";

/** Status chips for one website, derived from stored state only. */
export function siteIndicators(
  site: Pick<Website, "status" | "state" | "pausedReason" | "lastAvailabilityCheckAt" | "lastConfigCheckAt">,
  entitled: boolean,
  openFindings: number,
): SiteIndicator[] {
  if (site.status === "PENDING_VERIFICATION" || site.status === "VERIFICATION_FAILED") return ["VERIFICATION_REQUIRED"];
  if (!entitled || site.pausedReason === "SUBSCRIPTION_INACTIVE") return ["SUBSCRIPTION_INACTIVE"];
  if (site.status === "MONITORING_PAUSED") return ["MONITORING_PAUSED"];
  const out: SiteIndicator[] = [];
  if (!site.lastAvailabilityCheckAt || !site.lastConfigCheckAt) out.push("INITIAL_SCAN_RUNNING");
  if (site.state === "UP") out.push("WEBSITE_ONLINE");
  if (site.state === "DOWN") out.push("WEBSITE_OFFLINE");
  out.push("MONITORING_ACTIVE");
  if (openFindings > 0) out.push("SECURITY_FINDING_DETECTED");
  return out;
}

const HEADER_KEYS = ["hsts", "csp", "xContentTypeOptions", "referrerPolicy", "framing"] as const;

/** Everything the portal dashboard shows, scoped to one organization. All values come from stored results. */
export async function portalDashboard(orgId: string) {
  const [access, sites, findings, alerts, incidents, changes, uptime30d, response24h] = await Promise.all([
    accessStatus(orgId),
    prisma.website.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
    prisma.finding.findMany({
      where: { orgId, status: { in: ["OPEN", "IN_PROGRESS"] } },
      select: { id: true, websiteId: true, severity: true, title: true, lastSeenAt: true, status: true },
    }),
    prisma.alert.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, type: true, subject: true, status: true, createdAt: true } }),
    prisma.incident.findMany({ where: { orgId }, orderBy: { startedAt: "desc" }, take: 8, include: { website: { select: { hostname: true } } } }),
    prisma.configChange.findMany({ where: { orgId }, orderBy: { detectedAt: "desc" }, take: 10, include: { website: { select: { hostname: true } } } }),
    availabilitySeries(orgId, null, "30d"),
    availabilitySeries(orgId, null, "24h"),
  ]);

  const since24h = new Date(Date.now() - 24 * 3600_000);
  const checks = await prisma.availabilityCheck.groupBy({
    by: ["websiteId", "success"],
    where: { orgId, checkedAt: { gte: since24h } },
    _count: { _all: true },
  });
  const snapshots = await Promise.all(
    sites.map((s) => prisma.configSnapshot.findFirst({ where: { orgId, websiteId: s.id }, orderBy: { checkedAt: "desc" } })),
  );

  const siteRows = sites.map((s, i) => {
    const open = findings.filter((f) => f.websiteId === s.id);
    const rows = checks.filter((c) => c.websiteId === s.id);
    const total = rows.reduce((a, r) => a + r._count._all, 0);
    const up = rows.filter((r) => r.success).reduce((a, r) => a + r._count._all, 0);
    const snap = snapshots[i];
    const obs = snap ? ({ tls: snap.tls, headers: snap.headers, https: snap.https, dns: snap.dns } as unknown as ConfigObservation) : null;
    const headers = obs?.headers
      ? {
          hsts: obs.headers.hsts.present,
          csp: obs.headers.csp.present && !obs.headers.csp.reportOnly,
          xContentTypeOptions: (obs.headers.xContentTypeOptions ?? "").toLowerCase() === "nosniff",
          referrerPolicy: Boolean(obs.headers.referrerPolicy),
          framing: Boolean(obs.headers.xFrameOptions) || obs.headers.csp.hasFrameAncestors,
        }
      : null;
    const posture = postureScore(open.map((f) => f.severity as Severity), Boolean(s.lastConfigCheckAt));
    return {
      id: s.id,
      displayName: s.displayName,
      hostname: s.hostname,
      url: s.url,
      status: s.status,
      state: s.state,
      pausedReason: s.pausedReason,
      indicators: siteIndicators(s, access.active, open.length),
      uptime24h: total ? Math.round((up / total) * 10000) / 100 : null,
      lastCheckedAt: s.lastAvailabilityCheckAt,
      lastConfigCheckAt: s.lastConfigCheckAt,
      responseTimeMs: s.lastResponseTimeMs,
      openFindings: open.length,
      bySeverity: open.reduce<Partial<Record<Severity, number>>>((a, f) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {}),
      posture,
      tls: obs?.tls
        ? { trusted: obs.tls.authorized && obs.tls.hostnameMatches, daysRemaining: obs.tls.daysRemaining, issuer: obs.tls.issuer, validTo: obs.tls.validTo, protocol: obs.tls.protocol }
        : null,
      headers,
      headersPassed: headers ? HEADER_KEYS.filter((k) => headers[k]).length : null,
      httpsEnforced: obs?.https ? !obs.https.httpReachable || obs.https.redirectsToHttps : null,
      dns: obs?.dns ? { a: obs.dns.A.length, aaaa: obs.dns.AAAA.length, ns: obs.dns.NS, caa: obs.dns.CAA.length > 0, spf: Boolean(obs.dns.spf), dmarc: Boolean(obs.dns.dmarc) } : null,
    };
  });

  const monitored = siteRows.filter((s) => s.status === "CONNECTED");
  const latest = siteRows.reduce<Date | null>((acc, s) => (s.lastCheckedAt && (!acc || s.lastCheckedAt > acc) ? s.lastCheckedAt : acc), null);
  const tlsSoonest = siteRows.filter((s) => s.tls).sort((a, b) => a.tls!.daysRemaining - b.tls!.daysRemaining)[0] ?? null;
  const severity = findings.reduce<Record<Severity, number>>((a, f) => ({ ...a, [f.severity]: a[f.severity] + 1 }), { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });

  return {
    access,
    totals: {
      websites: siteRows.length,
      monitored: monitored.length,
      online: monitored.filter((s) => s.state === "UP").length,
      offline: monitored.filter((s) => s.state === "DOWN").length,
      awaitingVerification: siteRows.filter((s) => s.status === "PENDING_VERIFICATION" || s.status === "VERIFICATION_FAILED").length,
      initialScanRunning: siteRows.filter((s) => s.indicators.includes("INITIAL_SCAN_RUNNING")).length,
      openFindings: findings.length,
      latestCheckAt: latest,
      uptime30d: uptime30d.uptimePercent,
      tlsSoonest: tlsSoonest ? { hostname: tlsSoonest.hostname, daysRemaining: tlsSoonest.tls!.daysRemaining, trusted: tlsSoonest.tls!.trusted } : null,
      posture: aggregatePosture(siteRows.map((s) => s.posture)),
    },
    severity,
    sites: siteRows,
    topFindings: findings
      .sort((a, b) => ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(a.severity) - ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].indexOf(b.severity))
      .slice(0, 8)
      .map((f) => ({ ...f, hostname: sites.find((s) => s.id === f.websiteId)?.hostname ?? "" })),
    alerts,
    incidents,
    changes,
    uptime30d,
    response24h,
  };
}

export type PortalDashboard = Awaited<ReturnType<typeof portalDashboard>>;
export type { PostureScore };

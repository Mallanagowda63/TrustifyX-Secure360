import type { ReportPeriod, Severity } from "@prisma/client";
import { prisma } from "../db";

export interface ReportSite {
  hostname: string;
  displayName: string;
  status: string;
  checks: number;
  uptimePercent: number | null;
  avgResponseMs: number | null;
  downtimeIncidents: number;
  downtimeMinutes: number;
  tlsValidTo: string | null;
  tlsDaysRemaining: number | null;
  openFindings: Record<Severity, number>;
}

export interface ReportSummary {
  organization: string;
  period: ReportPeriod;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  totals: {
    websites: number;
    monitored: number;
    checks: number;
    uptimePercent: number | null;
    incidents: number;
    findingsOpened: number;
    findingsResolved: number;
    openFindings: Record<Severity, number>;
    configChanges: number;
  };
  sites: ReportSite[];
  topOpenFindings: Array<{ website: string; title: string; severity: Severity; firstSeen: string; remediation: string }>;
  incidents: Array<{ website: string; type: string; startedAt: string; resolvedAt: string | null; minutes: number }>;
  configChanges: Array<{ website: string; category: string; field: string; before: string | null; after: string | null; detectedAt: string }>;
}

const emptySev = (): Record<Severity, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
const SEV_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/** The most recent complete period: previous Monday-Sunday week or previous calendar month (UTC). */
export function previousPeriod(period: ReportPeriod, now = new Date()): { start: Date; end: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "WEEKLY") {
    const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
    const end = new Date(today.getTime() - dow * 86_400_000);
    return { start: new Date(end.getTime() - 7 * 86_400_000), end };
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  return { start, end };
}

/** Rolling window ending now: last 7 or 30 days (used for on-demand downloads). */
export function rollingPeriod(period: ReportPeriod, now = new Date()) {
  return { start: new Date(now.getTime() - (period === "WEEKLY" ? 7 : 30) * 86_400_000), end: now };
}

const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));

export async function buildReportSummary(orgId: string, period: ReportPeriod, start: Date, end: Date): Promise<ReportSummary> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
  const sites = await prisma.website.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } });

  const [checkAgg, incidents, openFindings, opened, resolved, changes] = await Promise.all([
    prisma.availabilityCheck.groupBy({
      by: ["websiteId", "success"],
      where: { orgId, checkedAt: { gte: start, lt: end } },
      _count: { _all: true },
      _avg: { responseTimeMs: true },
    }),
    prisma.incident.findMany({
      where: { orgId, startedAt: { lt: end }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: start } }] },
      include: { website: { select: { hostname: true } } },
      orderBy: { startedAt: "desc" },
    }),
    prisma.finding.findMany({ where: { orgId, status: { in: ["OPEN", "IN_PROGRESS"] } }, include: { website: { select: { hostname: true } } } }),
    prisma.finding.count({ where: { orgId, firstSeenAt: { gte: start, lt: end } } }),
    prisma.finding.count({ where: { orgId, resolvedAt: { gte: start, lt: end }, status: "RESOLVED" } }),
    prisma.configChange.findMany({
      where: { orgId, detectedAt: { gte: start, lt: end } },
      include: { website: { select: { hostname: true } } },
      orderBy: { detectedAt: "desc" },
      take: 100,
    }),
  ]);

  const totalSev = emptySev();
  for (const f of openFindings) totalSev[f.severity]++;

  let allChecks = 0;
  let allUp = 0;
  const reportSites: ReportSite[] = sites.map((s) => {
    const rows = checkAgg.filter((r) => r.websiteId === s.id);
    const total = rows.reduce((a, r) => a + r._count._all, 0);
    const up = rows.filter((r) => r.success).reduce((a, r) => a + r._count._all, 0);
    const okRow = rows.find((r) => r.success);
    allChecks += total;
    allUp += up;
    const siteIncidents = incidents.filter((i) => i.websiteId === s.id && i.type === "DOWNTIME");
    const sev = emptySev();
    for (const f of openFindings.filter((f) => f.websiteId === s.id)) sev[f.severity]++;
    return {
      hostname: s.hostname,
      displayName: s.displayName,
      status: s.status,
      checks: total,
      uptimePercent: total ? Math.round((up / total) * 10000) / 100 : null,
      avgResponseMs: okRow?._avg.responseTimeMs ? Math.round(okRow._avg.responseTimeMs) : null,
      downtimeIncidents: siteIncidents.length,
      downtimeMinutes: siteIncidents.reduce(
        (a, i) => a + minutesBetween(i.startedAt < start ? start : i.startedAt, i.resolvedAt && i.resolvedAt < end ? i.resolvedAt : end),
        0,
      ),
      tlsValidTo: s.tlsValidTo?.toISOString() ?? null,
      tlsDaysRemaining: s.tlsValidTo ? Math.floor((s.tlsValidTo.getTime() - Date.now()) / 86_400_000) : null,
      openFindings: sev,
    };
  });

  return {
    organization: org.name,
    period,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    generatedAt: new Date().toISOString(),
    totals: {
      websites: sites.length,
      monitored: sites.filter((s) => s.status === "CONNECTED").length,
      checks: allChecks,
      uptimePercent: allChecks ? Math.round((allUp / allChecks) * 10000) / 100 : null,
      incidents: incidents.length,
      findingsOpened: opened,
      findingsResolved: resolved,
      openFindings: totalSev,
      configChanges: changes.length,
    },
    sites: reportSites,
    topOpenFindings: openFindings
      .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
      .slice(0, 15)
      .map((f) => ({ website: f.website.hostname, title: f.title, severity: f.severity, firstSeen: f.firstSeenAt.toISOString(), remediation: f.remediation })),
    incidents: incidents.slice(0, 30).map((i) => ({
      website: i.website.hostname,
      type: i.type,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      minutes: minutesBetween(i.startedAt, i.resolvedAt ?? end),
    })),
    configChanges: changes.slice(0, 30).map((c) => ({
      website: c.website.hostname,
      category: c.category,
      field: c.field,
      before: c.previousValue,
      after: c.newValue,
      detectedAt: c.detectedAt.toISOString(),
    })),
  };
}

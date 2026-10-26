import type { Severity } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { DEFAULT_PREFS } from "../alerts/notify";
import { availabilitySeries } from "./websites";
import { listFindings, severityCounts } from "./findings";
import type { Actor } from "./actor";

export async function dashboardData(orgId: string) {
  const sites = await prisma.website.findMany({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      displayName: true,
      hostname: true,
      status: true,
      state: true,
      lastAvailabilityCheckAt: true,
      lastConfigCheckAt: true,
      lastResponseTimeMs: true,
      lastStatusCode: true,
      tlsValidTo: true,
    },
  });
  const since24h = new Date(Date.now() - 24 * 3600_000);
  const perSite = await prisma.availabilityCheck.groupBy({
    by: ["websiteId", "success"],
    where: { orgId, checkedAt: { gte: since24h } },
    _count: { _all: true },
  });
  const uptime24h = new Map<string, { up: number; total: number }>();
  for (const r of perSite) {
    const e = uptime24h.get(r.websiteId) ?? { up: 0, total: 0 };
    e.total += r._count._all;
    if (r.success) e.up += r._count._all;
    uptime24h.set(r.websiteId, e);
  }

  const [counts, findings, incidents, alerts, series30d, series24h] = await Promise.all([
    severityCounts(orgId),
    listFindings(orgId, { status: ["OPEN", "IN_PROGRESS"], take: 10 }),
    prisma.incident.findMany({
      where: { orgId },
      orderBy: { startedAt: "desc" },
      take: 10,
      include: { website: { select: { displayName: true, hostname: true } } },
    }),
    prisma.alert.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, type: true, subject: true, status: true, createdAt: true, recipient: true },
    }),
    availabilitySeries(orgId, null, "30d"),
    availabilitySeries(orgId, null, "24h"),
  ]);

  const connected = sites.filter((s) => s.status === "CONNECTED");
  const latest = sites.reduce<Date | null>(
    (acc, s) => (s.lastAvailabilityCheckAt && (!acc || s.lastAvailabilityCheckAt > acc) ? s.lastAvailabilityCheckAt : acc),
    null,
  );
  return {
    totals: {
      websites: sites.length,
      connected: connected.length,
      online: connected.filter((s) => s.state === "UP").length,
      offline: connected.filter((s) => s.state === "DOWN").length,
      pending: sites.filter((s) => s.status === "PENDING_VERIFICATION" || s.status === "VERIFICATION_FAILED").length,
      latestCheckAt: latest,
    },
    sites: sites.map((s) => {
      const u = uptime24h.get(s.id);
      return {
        ...s,
        uptime24h: u && u.total ? Math.round((u.up / u.total) * 10000) / 100 : null,
        tlsDaysRemaining: s.tlsValidTo ? Math.floor((s.tlsValidTo.getTime() - Date.now()) / 86_400_000) : null,
      };
    }),
    severityCounts: counts,
    topFindings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      status: f.status,
      lastSeenAt: f.lastSeenAt,
      remediation: f.remediation,
      website: f.website,
    })),
    incidents,
    alerts,
    uptime30d: series30d,
    response24h: series24h,
  };
}

export async function listIncidents(orgId: string, take = 100) {
  return prisma.incident.findMany({
    where: { orgId },
    orderBy: { startedAt: "desc" },
    take,
    include: { website: { select: { id: true, displayName: true, hostname: true } } },
  });
}

export async function listAlerts(orgId: string, take = 200) {
  return prisma.alert.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, type: true, subject: true, status: true, error: true, recipient: true, createdAt: true, websiteId: true },
  });
}

export async function listAuditLogs(orgId: string, take = 200) {
  const logs = await prisma.auditLog.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take });
  const userIds = [...new Set(logs.map((l) => l.userId).filter((x): x is string => Boolean(x)))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
  const emails = new Map(users.map((u) => [u.id, u.email]));
  return logs.map((l) => ({ ...l, userEmail: l.userId ? emails.get(l.userId) ?? null : null }));
}

export async function getPreferences(orgId: string, userId: string) {
  const p = await prisma.notificationPreference.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!p) return { ...DEFAULT_PREFS };
  const { id: _id, orgId: _o, userId: _u, ...rest } = p;
  return rest;
}

export async function updatePreferences(
  actor: Actor,
  input: Partial<{
    emailDowntime: boolean;
    emailTlsExpiry: boolean;
    emailFindings: boolean;
    findingMinSeverity: Severity;
    emailWeeklyReport: boolean;
    emailMonthlyReport: boolean;
  }>,
) {
  const saved = await prisma.notificationPreference.upsert({
    where: { orgId_userId: { orgId: actor.orgId, userId: actor.userId } },
    create: { orgId: actor.orgId, userId: actor.userId, ...DEFAULT_PREFS, ...input },
    update: input,
  });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "notifications.updated", metadata: input });
  const { id: _id, orgId: _o, userId: _u, ...rest } = saved;
  return rest;
}

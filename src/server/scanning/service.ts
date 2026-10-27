import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { ApiError } from "../api";
import { queue, QUEUES } from "../queue";
import { redisFast } from "../redis";
import { getEntitlement } from "../billing/entitlements";
import { assertCan, type Actor } from "../services/actor";
import { scanCancelKey } from "./constants";
import type { ScanAlert } from "./zap-report";
import type { ScanType } from "./zap-plan";
import { activeAuthorizationText, passiveAuthorizationText } from "./authorization";

// ─────────────────────────────── policy ───────────────────────────────

/** Scans per organization per calendar month (proposal; adjust in one place). Active scans: Business only. */
export const SCAN_QUOTAS: Record<string, { passive: number; active: number }> = {
  STARTER: { passive: 4, active: 0 },
  GROWTH: { passive: 20, active: 0 },
  BUSINESS: { passive: 60, active: 4 },
};
const WEBSITE_COOLDOWN_MS = 60 * 60_000;
const MAX_WINDOW_HOURS = 4;
const MAX_WINDOW_LEAD_DAYS = 14;
export const RUNNING_TIMEOUT_MS = 2 * 3600_000;

// ─────────────────────────────── helpers ───────────────────────────────

async function verifiedWebsite(orgId: string, websiteId: string) {
  const w = await prisma.website.findFirst({ where: { id: websiteId, orgId } });
  if (!w) throw new ApiError(404, "Website not found", "not_found");
  if (!w.verifiedAt || w.status === "PENDING_VERIFICATION") throw new ApiError(400, "Only websites with verified ownership can be scanned.", "website_not_verified");
  return w;
}

async function quotaFor(orgId: string) {
  const ent = await getEntitlement(orgId);
  if (!ent.active || !ent.plan) throw new ApiError(402, "An active Secure360 plan is required to run security scans.", "subscription_required");
  return { plan: ent.plan.code, quota: SCAN_QUOTAS[ent.plan.code] ?? { passive: 4, active: 0 } };
}

async function usedThisMonth(orgId: string, type: ScanType) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return prisma.vulnerabilityScan.count({ where: { orgId, type, createdAt: { gte: start }, status: { not: "CANCELLED" } } });
}

async function enqueue(scan: { id: string; targetUrl: string; type: string; windowStart: Date | null; windowEnd: Date | null }) {
  const delay = scan.windowStart ? Math.max(0, scan.windowStart.getTime() - Date.now()) : 0;
  await queue(QUEUES.scans).add(
    "scan",
    { scanId: scan.id, targetUrl: scan.targetUrl, type: scan.type, windowStart: scan.windowStart?.toISOString() ?? null, windowEnd: scan.windowEnd?.toISOString() ?? null },
    { jobId: `scan_${scan.id}`, delay, attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 200 } },
  );
}

// ─────────────────────────────── request / cancel ───────────────────────────────

export interface ScanRequest {
  websiteId: string;
  type: ScanType;
  /** The user ticked the authorization statement shown for this host. */
  confirmAuthorization: boolean;
  /** ACTIVE only: the user re-typed the hostname. */
  confirmHostname?: string;
  windowStart?: string;
  windowEnd?: string;
}

/** Creates an authorized scan of a verified website and queues it for the isolated scanner. */
export async function requestScan(actor: Actor, input: ScanRequest, trigger: "MANUAL" | "SCHEDULED" = "MANUAL") {
  assertCan(actor, "scan.manage");
  const website = await verifiedWebsite(actor.orgId, input.websiteId);
  const { plan, quota } = await quotaFor(actor.orgId);
  if (!input.confirmAuthorization) throw new ApiError(400, "Confirm that you are authorized to have this website scanned.", "authorization_required");

  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;
  let authorizationText: string;
  if (input.type === "ACTIVE") {
    if (quota.active === 0) throw new ApiError(402, `Active scanning is not included in the ${plan} plan.`, "plan_limit");
    if ((input.confirmHostname ?? "").trim().toLowerCase() !== website.hostname) {
      throw new ApiError(400, `Type ${website.hostname} to confirm the active scan target.`, "hostname_confirmation");
    }
    windowStart = input.windowStart ? new Date(input.windowStart) : null;
    windowEnd = input.windowEnd ? new Date(input.windowEnd) : null;
    if (!windowStart || !windowEnd || Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) {
      throw new ApiError(400, "Choose a maintenance window for the active scan.", "window_required");
    }
    const now = Date.now();
    if (windowEnd <= windowStart || windowEnd.getTime() - windowStart.getTime() > MAX_WINDOW_HOURS * 3600_000) {
      throw new ApiError(400, `The maintenance window must be at most ${MAX_WINDOW_HOURS} hours long.`, "invalid_window");
    }
    if (windowEnd.getTime() < now + 30 * 60_000 || windowStart.getTime() > now + MAX_WINDOW_LEAD_DAYS * 86_400_000) {
      throw new ApiError(400, `The window must end at least 30 minutes from now and start within ${MAX_WINDOW_LEAD_DAYS} days.`, "invalid_window");
    }
    if (windowStart.getTime() < now) windowStart = new Date(now);
    authorizationText = activeAuthorizationText(website.hostname, windowStart, windowEnd);
  } else {
    authorizationText = passiveAuthorizationText(website.hostname);
  }

  if ((await usedThisMonth(actor.orgId, input.type)) >= (input.type === "ACTIVE" ? quota.active : quota.passive)) {
    throw new ApiError(402, `This month's ${input.type.toLowerCase()} scan allowance for the ${plan} plan is used up.`, "plan_limit");
  }
  const inFlight = await prisma.vulnerabilityScan.findFirst({ where: { orgId: actor.orgId, status: { in: ["QUEUED", "RUNNING"] } } });
  if (inFlight) throw new ApiError(409, "Another scan for your organization is already queued or running.", "scan_in_progress");
  const recent = await prisma.vulnerabilityScan.findFirst({
    where: { websiteId: website.id, type: input.type, createdAt: { gte: new Date(Date.now() - WEBSITE_COOLDOWN_MS) }, status: { not: "CANCELLED" } },
  });
  if (recent && trigger === "MANUAL") throw new ApiError(429, "This website was scanned less than an hour ago.", "rate_limited");

  const scan = await prisma.vulnerabilityScan.create({
    data: {
      orgId: actor.orgId,
      websiteId: website.id,
      type: input.type,
      targetUrl: `https://${website.hostname}/`,
      trigger,
      requestedById: actor.userId,
      authorizationText,
      authorizedAt: new Date(),
      windowStart,
      windowEnd,
      message: windowStart && windowStart.getTime() > Date.now() + 60_000 ? `Scheduled for ${windowStart.toISOString()}` : "Waiting for a scanner",
    },
  });
  await audit({
    orgId: actor.orgId,
    userId: actor.userId,
    ip: actor.ip,
    action: input.type === "ACTIVE" ? "scan.active_authorized" : "scan.passive_authorized",
    targetType: "vulnerability_scan",
    targetId: scan.id,
    metadata: { website: website.hostname, trigger, authorizationText, windowStart: windowStart?.toISOString() ?? null, windowEnd: windowEnd?.toISOString() ?? null },
  });
  await enqueue(scan);
  return scan;
}

export async function cancelScan(actor: Actor, scanId: string) {
  assertCan(actor, "scan.manage");
  const scan = await prisma.vulnerabilityScan.findFirst({ where: { id: scanId, orgId: actor.orgId } });
  if (!scan) throw new ApiError(404, "Scan not found", "not_found");
  if (scan.status !== "QUEUED" && scan.status !== "RUNNING") throw new ApiError(400, "This scan is not running.", "not_running");
  await prisma.vulnerabilityScan.update({ where: { id: scan.id }, data: { cancelRequestedAt: new Date(), message: "Cancelling…" } });
  // Running: the scanner polls this key and stops ZAP. Queued: remove the job before it starts.
  await redisFast().set(scanCancelKey(scan.id), "1", "EX", 6 * 3600).catch(() => undefined);
  const job = await queue(QUEUES.scans).getJob(`scan_${scan.id}`);
  const state = await job?.getState();
  if (job && (state === "delayed" || state === "waiting" || state === "prioritized")) {
    await job.remove().catch(() => undefined);
    await prisma.vulnerabilityScan.update({ where: { id: scan.id }, data: { status: "CANCELLED", finishedAt: new Date(), message: "Cancelled before it started" } });
  }
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "scan.cancel_requested", targetType: "vulnerability_scan", targetId: scan.id });
  return { ok: true };
}

// ─────────────────────────────── results (main worker) ───────────────────────────────

export async function markScanRunning(scanId: string) {
  await prisma.vulnerabilityScan.updateMany({ where: { id: scanId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date(), message: "Scanner started" } });
}

export async function recordProgress(scanId: string, percent: number, message: string) {
  await prisma.vulnerabilityScan.updateMany({
    where: { id: scanId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "RUNNING", progress: Math.max(0, Math.min(100, Math.round(percent))), message: message.slice(0, 200) },
  });
}

/** Stores a finished scan's alerts. Idempotent: a scan's results are written once. */
export async function ingestScanResult(scanId: string, result: { alerts: ScanAlert[]; stats: Record<string, unknown> }) {
  const scan = await prisma.vulnerabilityScan.findUnique({ where: { id: scanId } });
  if (!scan || scan.status === "COMPLETED") return { stored: 0 };
  const data: Prisma.VulnerabilityFindingCreateManyInput[] = result.alerts.map((a) => ({
    orgId: scan.orgId,
    scanId: scan.id,
    websiteId: scan.websiteId,
    pluginId: a.pluginId,
    alertRef: a.alertRef ?? a.pluginId,
    name: a.name,
    risk: a.risk,
    confidence: a.confidence,
    description: a.description,
    solution: a.solution,
    reference: a.reference,
    cweId: a.cweId,
    wascId: a.wascId,
    instances: a.instances as unknown as Prisma.InputJsonValue,
    instanceCount: a.instanceCount,
  }));
  const stored = await prisma.$transaction(async (tx) => {
    const n = data.length ? (await tx.vulnerabilityFinding.createMany({ data, skipDuplicates: true })).count : 0;
    await tx.vulnerabilityScan.update({
      where: { id: scan.id },
      data: {
        status: "COMPLETED",
        progress: 100,
        finishedAt: new Date(),
        alertCount: data.length,
        stats: result.stats as Prisma.InputJsonValue,
        message: data.length ? `${data.length} alert type${data.length === 1 ? "" : "s"} found` : "No alerts found",
        error: null,
      },
    });
    return n;
  });
  await audit({ orgId: scan.orgId, action: "scan.completed", targetType: "vulnerability_scan", targetId: scan.id, metadata: { alerts: data.length } });
  return { stored };
}

export async function markScanFailed(scanId: string, reason: string) {
  const scan = await prisma.vulnerabilityScan.findUnique({ where: { id: scanId } });
  if (!scan || scan.status === "COMPLETED" || scan.status === "CANCELLED" || scan.status === "FAILED") return;
  const cancelled = Boolean(scan.cancelRequestedAt) || /cancelled by the customer/i.test(reason);
  await prisma.vulnerabilityScan.update({
    where: { id: scanId },
    data: {
      status: cancelled ? "CANCELLED" : "FAILED",
      finishedAt: new Date(),
      error: cancelled ? null : reason.slice(0, 1000),
      message: cancelled ? "Cancelled" : "Scan failed",
    },
  });
  await audit({ orgId: scan.orgId, action: cancelled ? "scan.cancelled" : "scan.failed", targetType: "vulnerability_scan", targetId: scan.id, metadata: { reason: reason.slice(0, 300) } });
}

/** Periodic housekeeping: time out stuck scans, expire missed windows, and run due schedules. */
export async function scanMaintenance(now = new Date()) {
  const stuck = await prisma.vulnerabilityScan.findMany({ where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - RUNNING_TIMEOUT_MS) } }, select: { id: true } });
  for (const s of stuck) await markScanFailed(s.id, "The scan did not finish within the time limit.");
  const missed = await prisma.vulnerabilityScan.findMany({ where: { status: "QUEUED", type: "ACTIVE", windowEnd: { lt: now } }, select: { id: true } });
  for (const s of missed) {
    await queue(QUEUES.scans).getJob(`scan_${s.id}`).then((j) => j?.remove()).catch(() => undefined);
    await prisma.vulnerabilityScan.update({ where: { id: s.id }, data: { status: "CANCELLED", finishedAt: now, message: "Maintenance window passed before a scanner was available" } });
  }
  return { timedOut: stuck.length, expired: missed.length, scheduled: await runDueSchedules(now) };
}

// ─────────────────────────────── schedules (passive only) ───────────────────────────────

export function nextRun(from: Date, frequency: "WEEKLY" | "MONTHLY") {
  const d = new Date(from);
  if (frequency === "WEEKLY") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export async function setSchedule(actor: Actor, input: { websiteId: string; frequency: "WEEKLY" | "MONTHLY" | "OFF"; confirmAuthorization: boolean }) {
  assertCan(actor, "scan.manage");
  const website = await verifiedWebsite(actor.orgId, input.websiteId);
  if (input.frequency === "OFF") {
    await prisma.scanSchedule.deleteMany({ where: { websiteId: website.id, orgId: actor.orgId } });
    await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "scan.schedule_removed", targetType: "website", targetId: website.id });
    return null;
  }
  await quotaFor(actor.orgId);
  if (!input.confirmAuthorization) throw new ApiError(400, "Confirm that you are authorized to have this website scanned.", "authorization_required");
  const authorizationText = `${passiveAuthorizationText(website.hostname)} This authorization covers recurring ${input.frequency.toLowerCase()} passive scans until I turn the schedule off.`;
  const data = { frequency: input.frequency, nextRunAt: nextRun(new Date(), input.frequency), enabled: true, authorizationText, authorizedById: actor.userId, authorizedAt: new Date() };
  const schedule = await prisma.scanSchedule.upsert({ where: { websiteId: website.id }, create: { ...data, orgId: actor.orgId, websiteId: website.id }, update: data });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "scan.schedule_set", targetType: "website", targetId: website.id, metadata: { frequency: input.frequency, authorizationText } });
  return schedule;
}

async function runDueSchedules(now: Date) {
  const due = await prisma.scanSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: now } }, take: 50 });
  let started = 0;
  for (const s of due) {
    await prisma.scanSchedule.update({ where: { id: s.id }, data: { nextRunAt: nextRun(now, s.frequency as "WEEKLY" | "MONTHLY"), lastRunAt: now } });
    const membership = await prisma.membership.findFirst({ where: { userId: s.authorizedById, orgId: s.orgId } });
    if (!membership) continue; // the authorizing user left the organization: authorization no longer valid
    try {
      await requestScan({ userId: s.authorizedById, orgId: s.orgId, role: membership.role, ip: "scheduler" }, { websiteId: s.websiteId, type: "PASSIVE", confirmAuthorization: true }, "SCHEDULED");
      started++;
    } catch (err) {
      await audit({ orgId: s.orgId, action: "scan.schedule_skipped", targetType: "website", targetId: s.websiteId, metadata: { reason: (err as Error).message } });
    }
  }
  return started;
}

// ─────────────────────────────── read ───────────────────────────────

export async function listScans(orgId: string) {
  const [scans, schedules, websites] = await Promise.all([
    prisma.vulnerabilityScan.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, type: true, status: true, trigger: true, progress: true, message: true, error: true, alertCount: true, createdAt: true,
        startedAt: true, finishedAt: true, windowStart: true, windowEnd: true, website: { select: { id: true, hostname: true } },
      },
    }),
    prisma.scanSchedule.findMany({ where: { orgId }, select: { websiteId: true, frequency: true, nextRunAt: true, lastRunAt: true, enabled: true } }),
    prisma.website.findMany({ where: { orgId, verifiedAt: { not: null }, status: { not: "PENDING_VERIFICATION" } }, select: { id: true, hostname: true, displayName: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return { scans, schedules, websites };
}

export async function getScan(orgId: string, scanId: string) {
  const scan = await prisma.vulnerabilityScan.findFirst({
    where: { id: scanId, orgId },
    include: { website: { select: { hostname: true, displayName: true } }, findings: { orderBy: [{ risk: "asc" }, { name: "asc" }] } },
  });
  if (!scan) throw new ApiError(404, "Scan not found", "not_found");
  const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
  scan.findings.sort((a, b) => (order[a.risk] ?? 9) - (order[b.risk] ?? 9) || a.name.localeCompare(b.name));
  return scan;
}

export async function scanUsage(orgId: string) {
  const ent = await getEntitlement(orgId);
  const quota = ent.plan ? SCAN_QUOTAS[ent.plan.code] ?? { passive: 4, active: 0 } : { passive: 0, active: 0 };
  return { plan: ent.plan?.code ?? null, active: ent.active, quota, used: { passive: await usedThisMonth(orgId, "PASSIVE"), active: await usedThisMonth(orgId, "ACTIVE") } };
}

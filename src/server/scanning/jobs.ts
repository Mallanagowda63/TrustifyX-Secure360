import { QueueEvents } from "bullmq";
import { prisma } from "../db";
import { redis } from "../redis";
import { queue, QUEUES } from "../queue";
import { ingestScanResult, markScanFailed, markScanRunning, recordProgress, scanMaintenance } from "./service";
import type { ScanAlert } from "./zap-report";

const scanIdOf = (jobId: string) => (jobId.startsWith("scan_") ? jobId.slice(5) : null);

/** Applies a scanner job's final state to the scan row (used by events and by reconciliation). */
export async function applyJobOutcome(scanId: string) {
  const job = await queue(QUEUES.scans).getJob(`scan_${scanId}`);
  if (!job) return "missing";
  const state = await job.getState();
  if (state === "completed") {
    await ingestScanResult(scanId, job.returnvalue as { alerts: ScanAlert[]; stats: Record<string, unknown> });
  } else if (state === "failed") {
    await markScanFailed(scanId, job.failedReason ?? "The scanner reported an error");
  } else if (state === "active") {
    await markScanRunning(scanId);
  }
  return state;
}

/** Main-worker listener: the scanner has no database access, so results are stored here. */
export function attachScanEvents() {
  const events = new QueueEvents(QUEUES.scans, { connection: redis().duplicate() });
  const safe = (fn: () => Promise<unknown>) => void fn().catch((err) => console.error("[scans] event handling failed:", (err as Error).message));
  events.on("active", ({ jobId }) => {
    const id = scanIdOf(jobId);
    if (id) safe(() => markScanRunning(id));
  });
  events.on("progress", ({ jobId, data }) => {
    const id = scanIdOf(jobId);
    const d = data as { percent?: number; message?: string } | undefined;
    if (id && d && typeof d.percent === "number") safe(() => recordProgress(id, d.percent!, String(d.message ?? "")));
  });
  events.on("completed", ({ jobId }) => {
    const id = scanIdOf(jobId);
    if (id) safe(() => applyJobOutcome(id));
  });
  events.on("failed", ({ jobId }) => {
    const id = scanIdOf(jobId);
    if (id) safe(() => applyJobOutcome(id));
  });
  return events;
}

/** Every 5 minutes: catch up on outcomes missed while the worker was down, then housekeeping. */
export async function scanSweep() {
  const open = await prisma.vulnerabilityScan.findMany({ where: { status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true }, take: 200 });
  for (const s of open) await applyJobOutcome(s.id).catch(() => undefined);
  return scanMaintenance();
}

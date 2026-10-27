import { Queue, type JobsOptions } from "bullmq";
import { redis } from "./redis";
import { SCAN_QUEUE } from "./scanning/constants";

export const QUEUES = {
  availability: "monitor-availability",
  config: "monitor-config",
  maintenance: "maintenance",
  billing: "billing-webhooks",
  /** Third-party integration syncs (Cloudflare, ...), separate so slow APIs never delay monitoring. */
  integrations: "integrations",
  /** Consumed only by the isolated scanner container (src/scanner). */
  scans: SCAN_QUEUE,
} as const;

const queues = new Map<string, Queue>();

export function queue(name: (typeof QUEUES)[keyof typeof QUEUES]): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis() });
    queues.set(name, q);
  }
  return q;
}

// Completed/failed jobs are removed so the deterministic jobId (one per website) can be
// re-added on the next schedule. While a job is waiting or active, re-adding is a no-op,
// which is the per-website deduplication.
const base: JobsOptions = {
  removeOnComplete: true,
  removeOnFail: true,
  attempts: 1,
};

export async function enqueueAvailability(websiteId: string, opts: { priority?: number } = {}) {
  await queue(QUEUES.availability).add("check", { websiteId }, { ...base, jobId: `avail_${websiteId}`, priority: opts.priority });
}

export async function enqueueConfig(websiteId: string, opts: { priority?: number } = {}) {
  await queue(QUEUES.config).add(
    "check",
    { websiteId },
    { ...base, jobId: `config_${websiteId}`, priority: opts.priority, attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  );
}

/** Immediate full scan, used after verification and for "Rescan" requests. */
export async function enqueueFullScan(websiteId: string) {
  await Promise.all([enqueueAvailability(websiteId, { priority: 1 }), enqueueConfig(websiteId, { priority: 1 })]);
}

/** Processes a stored, signature-verified payment webhook in the worker (one job per event). */
export async function enqueueWebhookProcessing(eventRowId: string) {
  await queue(QUEUES.billing).add(
    "process",
    { id: eventRowId },
    { jobId: `wh_${eventRowId}`, removeOnComplete: true, removeOnFail: { count: 500 }, attempts: 5, backoff: { type: "exponential", delay: 15_000 } },
  );
}

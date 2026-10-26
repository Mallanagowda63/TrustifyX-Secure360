import { Worker, type Job } from "bullmq";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { redis } from "@/server/redis";
import { QUEUES, enqueueAvailability, enqueueConfig, queue } from "@/server/queue";
import { runAvailabilityCheck, runConfigCheck } from "@/server/monitoring/run";
import { reverifyWebsite } from "@/server/websites/reverify";
import { runScheduledReports } from "@/server/reports/scheduled";
import { processWebhookEvent } from "@/server/billing/webhooks";
import { reconcileBilling } from "@/server/billing/reconcile";
import { ensurePlans } from "@/server/billing/plans";

const RETENTION_DAYS = 400;

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), "[worker]", ...args);
}

/** Finds websites whose next availability / configuration check is due and enqueues them. */
export async function scheduleDueChecks() {
  const dueAvail = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Website"
    WHERE status = 'CONNECTED' AND "verifiedAt" IS NOT NULL AND "authorizationConfirmedAt" IS NOT NULL
      AND ("lastAvailabilityCheckAt" IS NULL
           OR "lastAvailabilityCheckAt" + make_interval(secs => "availabilityIntervalSec") <= now())
    LIMIT 5000`;
  const dueConfig = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Website"
    WHERE status = 'CONNECTED' AND "verifiedAt" IS NOT NULL AND "authorizationConfirmedAt" IS NOT NULL
      AND ("lastConfigCheckAt" IS NULL
           OR "lastConfigCheckAt" + make_interval(secs => "configIntervalSec") <= now())
    LIMIT 1000`;
  for (const { id } of dueAvail) await enqueueAvailability(id);
  for (const { id } of dueConfig) await enqueueConfig(id);
  return { availability: dueAvail.length, config: dueConfig.length };
}

async function reverifyDue() {
  const cutoff = new Date(Date.now() - 24 * 3600_000);
  const sites = await prisma.website.findMany({
    where: {
      status: "CONNECTED",
      OR: [{ lastReverifiedAt: null, verifiedAt: { lt: cutoff } }, { lastReverifiedAt: { lt: cutoff } }],
    },
    take: 200,
  });
  for (const s of sites) {
    try {
      const r = await reverifyWebsite(s);
      if (!r.ok) log(`re-verification failed for ${s.hostname}: ${r.detail}`);
    } catch (err) {
      log(`re-verification error for ${s.hostname}:`, (err as Error).message);
    }
  }
  return { checked: sites.length };
}

async function cleanup() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const [sessions, checks, snaps] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    prisma.availabilityCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } }),
    prisma.configSnapshot.deleteMany({ where: { checkedAt: { lt: cutoff } } }),
  ]);
  await prisma.invitation.deleteMany({ where: { expiresAt: { lt: new Date() }, acceptedAt: null } });
  return { sessions: sessions.count, checks: checks.count, snapshots: snaps.count };
}

async function main() {
  const e = env();
  const connection = redis();
  log("starting", { concurrency: e.MONITOR_CONCURRENCY, configConcurrency: e.MONITOR_CONFIG_CONCURRENCY });

  const availability = new Worker(
    QUEUES.availability,
    async (job: Job<{ websiteId: string }>) => runAvailabilityCheck(job.data.websiteId),
    { connection, concurrency: e.MONITOR_CONCURRENCY },
  );

  const config = new Worker(
    QUEUES.config,
    async (job: Job<{ websiteId: string }>) => runConfigCheck(job.data.websiteId),
    // Config checks open several connections per site; keep them few and rate-limited.
    { connection, concurrency: e.MONITOR_CONFIG_CONCURRENCY, limiter: { max: 30, duration: 60_000 } },
  );

  const maintenance = new Worker(
    QUEUES.maintenance,
    async (job: Job) => {
      switch (job.name) {
        case "tick":
          return scheduleDueChecks();
        case "reverify":
          return reverifyDue();
        case "cleanup":
          return cleanup();
        case "weekly-reports":
          return runScheduledReports("WEEKLY");
        case "monthly-reports":
          return runScheduledReports("MONTHLY");
        case "billing-reconcile":
          return reconcileBilling();
        default:
          throw new Error(`Unknown maintenance job ${job.name}`);
      }
    },
    { connection, concurrency: 1 },
  );

  const billing = new Worker(QUEUES.billing, async (job: Job<{ id: string }>) => processWebhookEvent(job.data.id), {
    connection,
    concurrency: 2,
  });

  for (const w of [availability, config, maintenance, billing]) {
    w.on("failed", (job, err) => log(`job failed ${w.name}/${job?.name} ${job?.id}:`, err.message));
    w.on("error", (err) => log(`worker error ${w.name}:`, err.message));
  }

  const mq = queue(QUEUES.maintenance);
  // Keep a short history for debugging; without limits completed jobs accumulate in Redis forever.
  const opts = { removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } };
  await mq.upsertJobScheduler("tick", { every: 60_000 }, { name: "tick", opts });
  await mq.upsertJobScheduler("reverify", { every: 3600_000 }, { name: "reverify", opts });
  await mq.upsertJobScheduler("cleanup", { pattern: "30 3 * * *", tz: "UTC" }, { name: "cleanup", opts });
  await mq.upsertJobScheduler("weekly-reports", { pattern: "0 7 * * 1", tz: "UTC" }, { name: "weekly-reports", opts });
  await mq.upsertJobScheduler("monthly-reports", { pattern: "0 7 1 * *", tz: "UTC" }, { name: "monthly-reports", opts });
  await mq.upsertJobScheduler("billing-reconcile", { every: 10 * 60_000 }, { name: "billing-reconcile", opts });
  await ensurePlans();
  // Run one scheduling pass immediately on boot.
  await mq.add("tick", {}, { removeOnComplete: true, removeOnFail: true });

  const shutdown = async (signal: string) => {
    log(`received ${signal}, draining...`);
    await Promise.allSettled([availability.close(), config.close(), maintenance.close(), billing.close()]);
    await prisma.$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (process.env.VITEST === undefined) {
  main().catch((err) => {
    console.error("[worker] fatal", err);
    process.exit(1);
  });
}

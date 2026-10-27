import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { SCAN_QUEUE, scanCancelKey } from "@/server/scanning/constants";
import { runScan, type ScanJobData } from "./run";

/**
 * Isolated vulnerability-scan worker. Runs in its own container next to OWASP ZAP with:
 *  - no database credentials (results go back through the job queue; the main worker stores them)
 *  - CPU/memory/PID limits and an egress network separate from the application (deploy/)
 *  - one scan at a time per container
 * Configuration: REDIS_URL, ZAP_COMMAND (default zap.sh), and for local test fixtures only
 * SCANNER_ALLOW_PRIVATE_TARGETS / SCANNER_EXTRA_PORTS (refused when NODE_ENV=production).
 */

function config() {
  const prod = process.env.NODE_ENV === "production";
  const allowPrivate = process.env.SCANNER_ALLOW_PRIVATE_TARGETS === "true";
  if (prod && (allowPrivate || process.env.SCANNER_EXTRA_PORTS)) {
    throw new Error("SCANNER_ALLOW_PRIVATE_TARGETS / SCANNER_EXTRA_PORTS must not be set in production");
  }
  return {
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    zapCommand: process.env.ZAP_COMMAND ?? "zap.sh",
    addressPolicy: allowPrivate ? () => true : undefined,
    extraPorts: (process.env.SCANNER_EXTRA_PORTS ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0),
  };
}

async function main() {
  const c = config();
  const connection = new IORedis(c.redisUrl, { maxRetriesPerRequest: null });
  const control = new IORedis(c.redisUrl, { maxRetriesPerRequest: 1 });
  const worker = new Worker(
    SCAN_QUEUE,
    async (job: Job<ScanJobData>) =>
      runScan(job.data, {
        zapCommand: c.zapCommand,
        addressPolicy: c.addressPolicy,
        extraPorts: c.extraPorts,
        isCancelled: async () => (await control.exists(scanCancelKey(job.data.scanId))) === 1,
        onProgress: (percent, message) => job.updateProgress({ percent, message }),
      }),
    // ZAP is memory hungry and must not run scans in parallel inside one container.
    { connection, concurrency: 1, lockDuration: 120_000, stalledInterval: 120_000, maxStalledCount: 0 },
  );
  worker.on("failed", (job, err) => console.log(`[scanner] scan ${job?.data.scanId} failed: ${err.message}`));
  worker.on("completed", (job) => console.log(`[scanner] scan ${job.data.scanId} completed`));
  console.log("[scanner] ready", { zap: c.zapCommand });

  const shutdown = async () => {
    await worker.close();
    connection.disconnect();
    control.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (process.env.VITEST === undefined) {
  main().catch((err) => {
    console.error("[scanner] fatal", err);
    process.exit(1);
  });
}

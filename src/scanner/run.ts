import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildZapPlan, type ScanType } from "@/server/scanning/zap-plan";
import { parseZapReport, type ScanAlert } from "@/server/scanning/zap-report";
import type { Resolver } from "@/server/security/safe-fetch";
import { startScopeProxy, type ScopeProxyStats } from "./scope-proxy";

export interface ScanJobData {
  scanId: string;
  targetUrl: string;
  type: ScanType;
  /** ISO timestamps; active scans may only run inside this window. */
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface ScanJobResult {
  alerts: ScanAlert[];
  stats: ScopeProxyStats & { zapExitCode: number | null; durationMs: number; timedOut: boolean };
  logTail: string;
}

export interface RunContext {
  zapCommand: string;
  zapArgs?: string[];
  isCancelled: () => Promise<boolean>;
  onProgress: (percent: number, message: string) => Promise<void> | void;
  addressPolicy?: (ip: string) => boolean;
  resolver?: Resolver;
  extraPorts?: number[];
  maxMinutes?: number;
  userAgent?: string;
}

export class ScanAbortedError extends Error {}

const PASSIVE_MAX_MIN = 20;
const ACTIVE_MAX_MIN = 75;

/** Progress milestones from the Automation Framework's stdout ("Job spider started", ...). */
const MILESTONES: Array<[RegExp, number, string]> = [
  [/Job spider started/i, 10, "Crawling the website"],
  [/Job spider finished/i, 40, "Crawl finished"],
  [/Job passiveScan-wait started/i, 50, "Analysing responses"],
  [/Job activeScan started/i, 60, "Active scan running"],
  [/Job activeScan finished/i, 85, "Active scan finished"],
  [/Job report started/i, 92, "Writing report"],
];

export async function runScan(job: ScanJobData, ctx: RunContext): Promise<ScanJobResult> {
  const target = new URL(job.targetUrl);
  const now = Date.now();
  let maxMinutes = ctx.maxMinutes ?? (job.type === "ACTIVE" ? ACTIVE_MAX_MIN : PASSIVE_MAX_MIN);
  if (job.type === "ACTIVE") {
    // Defence in depth: the scheduler only releases active scans inside the window, but re-check here.
    const start = job.windowStart ? Date.parse(job.windowStart) : NaN;
    const end = job.windowEnd ? Date.parse(job.windowEnd) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || now < start - 60_000 || now >= end) {
      throw new ScanAbortedError("Active scan is outside its authorized maintenance window");
    }
    maxMinutes = Math.max(1, Math.min(maxMinutes, Math.floor((end - now) / 60_000)));
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "tx-scan-"));
  const proxy = await startScopeProxy({
    hostname: target.hostname,
    addressPolicy: ctx.addressPolicy,
    resolver: ctx.resolver,
    extraPorts: ctx.extraPorts,
  });
  const started = Date.now();
  let log = "";
  let timedOut = false;
  let exitCode: number | null = null;
  try {
    const plan = buildZapPlan({
      targetUrl: job.targetUrl,
      type: job.type,
      proxyPort: proxy.port,
      reportDir: workDir,
      reportFile: "report",
      userAgent: ctx.userAgent ?? "TrustifyX-Secure360-Scanner/1.0 (authorized scan; +https://trustifyx.com/scanner)",
      maxMinutes,
    });
    const planPath = path.join(workDir, "plan.yaml");
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    await ctx.onProgress(5, "Starting scanner");

    const child = spawn(ctx.zapCommand, [...(ctx.zapArgs ?? []), "-cmd", "-autorun", planPath], { stdio: ["ignore", "pipe", "pipe"] });
    let progress = 5;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      log = (log + text).slice(-20_000);
      for (const [re, pct, msg] of MILESTONES) {
        if (pct > progress && re.test(text)) {
          progress = pct;
          void ctx.onProgress(pct, msg);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const killAfter = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
    }, (maxMinutes + 5) * 60_000);
    let cancelled = false;
    const poll = setInterval(async () => {
      if (await ctx.isCancelled().catch(() => false)) {
        cancelled = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
      }
    }, 3_000);

    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    }).finally(() => {
      clearTimeout(killAfter);
      clearInterval(poll);
    });
    if (cancelled) throw new ScanAbortedError("Scan cancelled by the customer");

    const files = (await readdir(workDir)).filter((f) => f.startsWith("report") && f.endsWith(".json"));
    if (!files.length) throw new Error(`ZAP did not produce a JSON report (exit code ${exitCode}${timedOut ? ", timed out" : ""})`);
    const report = JSON.parse(await readFile(path.join(workDir, files[0]), "utf8"));
    const alerts = parseZapReport(report, target.hostname);
    await ctx.onProgress(100, "Scan complete");
    return {
      alerts,
      stats: { ...proxy.stats, zapExitCode: exitCode, durationMs: Date.now() - started, timedOut },
      logTail: log.slice(-4000),
    };
  } finally {
    await proxy.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

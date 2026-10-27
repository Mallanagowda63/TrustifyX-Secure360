/**
 * Builds an OWASP ZAP Automation Framework plan (https://www.zaproxy.org/docs/automate/automation-framework/).
 * Pure function, no I/O. The plan is emitted as JSON, which the framework's YAML parser accepts.
 *
 * Safety properties:
 *  - one context containing only the verified origin (includePaths anchored to it)
 *  - all traffic goes through the scanner's scope proxy (env.proxy), which refuses every
 *    other host and every non-public address, so out-of-scope URLs are blocked at the network level
 *  - PASSIVE: spider + passive scan only, no attack payloads
 *  - ACTIVE: conservative strength/threshold, request delay, low thread count, hard time limits,
 *    and rules that can disrupt services (buffer overflow, format string) switched off
 */

export type ScanType = "PASSIVE" | "ACTIVE";

export interface PlanInput {
  targetUrl: string;
  type: ScanType;
  proxyPort: number;
  reportDir: string;
  reportFile: string;
  userAgent: string;
  /** Hard cap for the whole plan, minutes. */
  maxMinutes: number;
}

/** Active-scan rules that can crash or degrade fragile services; never run. IDs from https://www.zaproxy.org/docs/alerts/ */
export const DISABLED_ACTIVE_RULES = [
  { id: 30001, name: "Buffer Overflow" },
  { id: 30002, name: "Format String Error" },
];

export const SPIDER_LIMITS = { maxDurationMin: 5, maxDepth: 5, maxChildren: 50, threadCount: 2 } as const;
export const ACTIVE_LIMITS = { maxScanDurationInMins: 60, maxRuleDurationInMins: 5, threadPerHost: 2, delayInMs: 200 } as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scopeRegex(targetUrl: string): string {
  const u = new URL(targetUrl);
  return `^${escapeRegex(`${u.protocol}//${u.host}`)}(/.*)?$`;
}

export function buildZapPlan(input: PlanInput) {
  const u = new URL(input.targetUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) targets can be scanned");
  const origin = `${u.protocol}//${u.host}/`;
  const jobs: Array<Record<string, unknown>> = [
    {
      type: "spider",
      parameters: {
        context: "target",
        url: origin,
        maxDuration: SPIDER_LIMITS.maxDurationMin,
        maxDepth: SPIDER_LIMITS.maxDepth,
        maxChildren: SPIDER_LIMITS.maxChildren,
        threadCount: SPIDER_LIMITS.threadCount,
        userAgent: input.userAgent,
        acceptCookies: true,
        // Never submit forms (GET or POST): the authorization statement promises no form submissions.
        postForm: false,
        processForm: false,
      },
    },
    { type: "passiveScan-wait", parameters: { maxDuration: 5 } },
  ];
  if (input.type === "ACTIVE") {
    jobs.push({
      type: "activeScan",
      parameters: {
        context: "target",
        maxScanDurationInMins: ACTIVE_LIMITS.maxScanDurationInMins,
        maxRuleDurationInMins: ACTIVE_LIMITS.maxRuleDurationInMins,
        threadPerHost: ACTIVE_LIMITS.threadPerHost,
        delayInMs: ACTIVE_LIMITS.delayInMs,
        maxAlertsPerRule: 10,
      },
      policyDefinition: {
        defaultStrength: "Low",
        defaultThreshold: "Medium",
        rules: DISABLED_ACTIVE_RULES.map((r) => ({ id: r.id, name: r.name, threshold: "Off" })),
      },
    });
    jobs.push({ type: "passiveScan-wait", parameters: { maxDuration: 5 } });
  }
  jobs.push({
    type: "report",
    parameters: {
      template: "traditional-json",
      reportDir: input.reportDir,
      reportFile: input.reportFile,
      reportTitle: "TrustifyX Secure360 scan",
    },
  });
  return {
    env: {
      contexts: [{ name: "target", urls: [origin], includePaths: [scopeRegex(input.targetUrl)], excludePaths: [] }],
      parameters: { failOnError: false, failOnWarning: false, progressToStdout: true, maxDuration: input.maxMinutes * 60 },
      proxy: { hostname: "127.0.0.1", port: input.proxyPort },
    },
    jobs,
  };
}

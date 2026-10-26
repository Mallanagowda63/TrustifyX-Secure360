import { safeFetch, SafeFetchError, type SafeFetchOptions, type SafeResponse } from "../security/safe-fetch";

export interface AvailabilityResult {
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  redirectCount: number;
  finalUrl: string | null;
  attempts: number;
  error: string | null;
  /** Final HTTPS response, reused by configuration checks. */
  response?: SafeResponse;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A site is "up" when the final response (after redirects) is 2xx/3xx. */
export function isUpStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

/**
 * GET the URL with one retry on failure. A single retry filters transient blips;
 * confirming downtime additionally requires consecutive failed checks (see run.ts).
 */
export async function checkAvailability(
  url: string,
  opts: { retries?: number; retryDelayMs?: number; fetch?: Partial<SafeFetchOptions> } = {},
): Promise<AvailabilityResult> {
  const retries = opts.retries ?? 1;
  let last: AvailabilityResult | null = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await safeFetch(url, { method: "GET", maxBodyBytes: 512 * 1024, ...opts.fetch });
      const success = isUpStatus(res.status);
      last = {
        success,
        statusCode: res.status,
        responseTimeMs: res.totalMs,
        redirectCount: res.redirects.length,
        finalUrl: res.url,
        attempts: attempt,
        error: success ? null : `HTTP ${res.status}`,
        response: res,
      };
      if (success) return last;
      // 4xx is a deterministic answer from the server; retrying will not change it.
      if (res.status < 500) return last;
    } catch (err) {
      const message = err instanceof SafeFetchError ? `${err.code}: ${err.message}` : (err as Error).message;
      last = {
        success: false,
        statusCode: null,
        responseTimeMs: null,
        redirectCount: 0,
        finalUrl: null,
        attempts: attempt,
        error: message.slice(0, 500),
      };
      // Policy rejections (SSRF guard) are not transient.
      if (err instanceof SafeFetchError && (err.code === "SSRF_BLOCKED" || err.code === "REDIRECT_BLOCKED")) return last;
    }
    if (attempt <= retries) await sleep(opts.retryDelayMs ?? 3000);
  }
  return last!;
}

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import type { LookupFunction } from "node:net";
import { isIpLiteral, isPublicAddress } from "./ip";
import { env } from "../env";

/**
 * Outbound HTTP client for monitoring customer websites.
 *
 * SSRF defences:
 *  - only http/https on ports 80/443
 *  - hostname resolved once; request fails if ANY resolved address is non-public
 *  - the socket connects to the vetted IP (custom `lookup`), so a second DNS answer
 *    cannot redirect the connection (DNS rebinding); the remote address is re-checked
 *    after connect as defence in depth
 *  - redirects are followed manually, each hop re-validated, with a hop limit
 *  - hard timeout and response-size cap; no connection reuse between hosts
 */

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "SSRF_BLOCKED"
  | "DNS_FAILURE"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_BLOCKED"
  | "TLS_ERROR"
  | "CONNECTION_ERROR";

export class SafeFetchError extends Error {
  constructor(
    public code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemResolver: Resolver = async (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  /** Refuse redirects that leave the original hostname. */
  sameHostOnly?: boolean;
  /** Allow plain http (used only for the HTTPS-enforcement check). */
  allowHttp?: boolean;
  resolver?: Resolver;
  /**
   * Which destination IPs may be contacted. Defaults to public unicast only
   * (isPublicAddress). Tests inject a policy; production code never sets this.
   */
  addressPolicy?: (ip: string) => boolean;
  /** Test hook: extra ports besides 80/443. Production code never sets this. */
  allowedPorts?: string[];
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  bodyTruncated: boolean;
  redirects: RedirectHop[];
  remoteAddress: string;
  totalMs: number;
  firstByteMs: number;
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);
const USER_AGENT = "TrustifyX-Secure360-Monitor/1.0 (+https://trustifyx.com/monitoring)";

export function addressAllowed(opts: Pick<SafeFetchOptions, "addressPolicy">, ip: string): boolean {
  if (opts.addressPolicy) return opts.addressPolicy(ip);
  if (env().MONITOR_ALLOW_PRIVATE_TARGETS) return true;
  return isPublicAddress(ip);
}

export function validateTarget(raw: string, opts: SafeFetchOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("INVALID_URL", "Invalid URL");
  }
  const okProto = u.protocol === "https:" || (opts.allowHttp && u.protocol === "http:");
  if (!okProto) throw new SafeFetchError("SSRF_BLOCKED", `Protocol ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new SafeFetchError("SSRF_BLOCKED", "Credentials in URL are not allowed");
  if (!ALLOWED_PORTS.has(u.port) && !opts.allowedPorts?.includes(u.port)) throw new SafeFetchError("SSRF_BLOCKED", `Port ${u.port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host) && !addressAllowed(opts, host)) {
    throw new SafeFetchError("SSRF_BLOCKED", "Destination address is not publicly routable");
  }
  if (!isIpLiteral(host) && !host.includes(".")) {
    throw new SafeFetchError("SSRF_BLOCKED", "Single-label hostnames are not allowed");
  }
  return u;
}

/** Resolve and vet every address. Returns the address to pin the connection to. */
export async function resolvePublic(
  hostname: string,
  opts: SafeFetchOptions = {},
): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) {
    if (!addressAllowed(opts, host)) {
      throw new SafeFetchError("SSRF_BLOCKED", "Destination address is not publicly routable");
    }
    return { address: host, family: host.includes(":") ? 6 : 4 };
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await (opts.resolver ?? systemResolver)(host);
  } catch (err) {
    throw new SafeFetchError("DNS_FAILURE", `DNS lookup failed for ${host}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (!addrs.length) throw new SafeFetchError("DNS_FAILURE", `No DNS records for ${host}`);
  // Reject if ANY answer is non-public, so a mixed answer set cannot be used to reach internal hosts.
  const bad = addrs.find((a) => !addressAllowed(opts, a.address));
  if (bad) {
    throw new SafeFetchError("SSRF_BLOCKED", `${host} resolves to a non-public address (${bad.address})`);
  }
  return addrs.find((a) => a.family === 4) ?? addrs[0];
}

function pinnedLookup(address: string, family: number): LookupFunction {
  return ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
    if (options && options.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as unknown as LookupFunction;
}

function classifyNetworkError(err: NodeJS.ErrnoException): SafeFetchError {
  const code = err.code ?? "";
  if (code.startsWith("ERR_TLS") || /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return new SafeFetchError("TLS_ERROR", `TLS error: ${code || err.message}`);
  }
  return new SafeFetchError("CONNECTION_ERROR", `Connection failed: ${code || err.message}`);
}

async function singleRequest(
  target: URL,
  opts: Required<Pick<SafeFetchOptions, "method" | "timeoutMs" | "maxBodyBytes">> & SafeFetchOptions,
  deadline: number,
): Promise<Omit<SafeResponse, "redirects" | "url">> {
  const pinned = await resolvePublic(target.hostname, opts);
  const started = Date.now();
  const remaining = deadline - started;
  if (remaining <= 0) throw new SafeFetchError("TIMEOUT", "Request timed out");

  const isHttps = target.protocol === "https:";
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };

    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: opts.method,
        agent: false,
        lookup: pinnedLookup(pinned.address, pinned.family),
        servername: isIpLiteral(target.hostname) ? undefined : target.hostname,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Encoding": "identity",
          Connection: "close",
        },
      },
      (res) => {
        const firstByteMs = Date.now() - started;
        const remoteAddress = res.socket?.remoteAddress ?? pinned.address;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > opts.maxBodyBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, opts.maxBodyBytes - (size - chunk.length)));
            res.destroy();
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
                bodyTruncated: true,
                remoteAddress,
                totalMs: Date.now() - started,
                firstByteMs,
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
              bodyTruncated: truncated,
              remoteAddress,
              totalMs: Date.now() - started,
              firstByteMs,
            }),
          ),
        );
        res.on("error", (err) => finish(() => reject(classifyNetworkError(err as NodeJS.ErrnoException))));
      },
    );

    req.on("socket", (socket) => {
      socket.on("connect", () => {
        const ra = socket.remoteAddress;
        if (ra && !addressAllowed(opts, ra)) {
          req.destroy(new SafeFetchError("SSRF_BLOCKED", `Connected to non-public address ${ra}`));
        }
      });
    });

    req.on("error", (err) => {
      if (err instanceof SafeFetchError) finish(() => reject(err));
      else finish(() => reject(classifyNetworkError(err as NodeJS.ErrnoException)));
    });

    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new SafeFetchError("TIMEOUT", `Request timed out after ${opts.timeoutMs}ms`)));
    }, remaining);

    req.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const e = env();
  const opts = {
    method: options.method ?? "GET",
    timeoutMs: options.timeoutMs ?? e.MONITOR_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? e.MONITOR_MAX_REDIRECTS,
    maxBodyBytes: options.maxBodyBytes ?? 256 * 1024,
    ...options,
  } as Required<Pick<SafeFetchOptions, "method" | "timeoutMs" | "maxBodyBytes" | "maxRedirects">> & SafeFetchOptions;

  const deadline = Date.now() + opts.timeoutMs;
  const origin = validateTarget(rawUrl, opts);
  const redirects: RedirectHop[] = [];
  let current = origin;
  const overallStart = Date.now();

  for (;;) {
    const res = await singleRequest(current, opts, deadline);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (redirects.length >= opts.maxRedirects) {
        throw new SafeFetchError("TOO_MANY_REDIRECTS", `More than ${opts.maxRedirects} redirects`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SafeFetchError("REDIRECT_BLOCKED", "Redirect to an invalid URL");
      }
      redirects.push({ url: current.toString(), status: res.status, location: next.toString() });
      try {
        // A redirect may move http -> https; it may never reach a disallowed scheme/port/address.
        next = validateTarget(next.toString(), { ...opts, allowHttp: true });
      } catch (err) {
        throw new SafeFetchError("REDIRECT_BLOCKED", `Unsafe redirect blocked: ${(err as Error).message}`);
      }
      if (opts.sameHostOnly && next.hostname !== origin.hostname) {
        throw new SafeFetchError("REDIRECT_BLOCKED", `Redirect to another host (${next.hostname}) is not allowed`);
      }
      current = next;
      continue;
    }
    return { ...res, url: current.toString(), redirects, totalMs: Date.now() - overallStart };
  }
}

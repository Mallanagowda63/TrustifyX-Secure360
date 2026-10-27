import http from "node:http";
import net from "node:net";
import { isPublicAddress } from "@/server/security/ip";
import { resolvePublic, type Resolver } from "@/server/security/safe-fetch";

/**
 * Local forward proxy that ZAP is forced to use (plan env.proxy). It is the network-level scope
 * guard: only the approved hostname on ports 80/443 is reachable, the hostname must resolve to
 * public addresses only (re-checked per connection, connection pinned to the vetted IP), and
 * every other destination (third-party scripts, CDNs, redirects to other hosts, internal
 * addresses, cloud metadata) is refused. Concurrency is capped as a rate limit.
 */

export interface ScopeProxyOptions {
  hostname: string;
  /** Test environments only. Production scanners never set this. */
  addressPolicy?: (ip: string) => boolean;
  resolver?: Resolver;
  /** Additional allowed ports (test fixtures on random ports). */
  extraPorts?: number[];
  maxConcurrent?: number;
}

export interface ScopeProxyStats {
  allowed: number;
  refused: number;
  /** Requests turned away because the concurrency cap was reached (rate limiting, not scope). */
  throttled: number;
  refusedHosts: string[];
}

export async function startScopeProxy(opts: ScopeProxyOptions) {
  const target = opts.hostname.toLowerCase();
  const ports = new Set([80, 443, ...(opts.extraPorts ?? [])]);
  const policy = opts.addressPolicy ?? isPublicAddress;
  const maxConcurrent = opts.maxConcurrent ?? 6;
  const stats: ScopeProxyStats = { allowed: 0, refused: 0, throttled: 0, refusedHosts: [] };
  let active = 0;

  const refuse = (host: string) => {
    stats.refused++;
    if (stats.refusedHosts.length < 50 && !stats.refusedHosts.includes(host)) stats.refusedHosts.push(host);
  };

  async function vet(host: string, port: number): Promise<string | null> {
    if (host.toLowerCase() !== target || !ports.has(port)) return null;
    try {
      const { address } = await resolvePublic(host, { addressPolicy: policy, resolver: opts.resolver });
      return address;
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    // Sockets can reset at any time (also while the destination is being vetted): never let that crash the scanner.
    req.on("error", () => res.destroy());
    res.on("error", () => undefined);
    // Plain-http proxy requests carry an absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const address = await vet(url.hostname, port);
    if (!address || url.protocol !== "http:") {
      refuse(url.hostname);
      res.writeHead(403, { "content-type": "text/plain" }).end("Out of scope for this TrustifyX scan");
      return;
    }
    if (active >= maxConcurrent) {
      stats.throttled++;
      res.writeHead(503, { "retry-after": "1" }).end();
      return;
    }
    stats.allowed++;
    active++;
    const upstream = http.request(
      { host: address, port, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...req.headers, host: url.host }, setHost: false },
      (up) => {
        up.on("error", () => res.destroy());
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end());
    upstream.on("close", () => active--);
    req.pipe(upstream);
  });

  // HTTPS: CONNECT tunnels, only to the target host.
  server.on("connect", async (req, clientSocket: net.Socket, head) => {
    let upstreamRef: net.Socket | null = null;
    clientSocket.on("error", () => upstreamRef?.destroy());
    const [host, portStr] = (req.url ?? "").split(":");
    const port = Number(portStr || 443);
    const address = await vet(host ?? "", port);
    if (!address) {
      refuse(host ?? "");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (active >= maxConcurrent) {
      stats.throttled++;
      clientSocket.end("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\n\r\n");
      return;
    }
    stats.allowed++;
    active++;
    const upstream = net.connect(port, address, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstreamRef = upstream;
    upstream.setTimeout(120_000, () => upstream.destroy());
    const done = () => {
      active = Math.max(0, active - 1);
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.once("close", done);
    upstream.on("error", () => clientSocket.destroy());
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

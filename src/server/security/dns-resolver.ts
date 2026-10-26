import dns from "node:dns";
import { env } from "../env";

let resolver: dns.promises.Resolver | null = null;

/**
 * DNS resolver for verification and DNS monitoring. Using explicit public resolvers
 * (DNS_SERVERS) gives every customer the same answers the internet sees, independent of
 * the host's split-horizon or local DNS configuration.
 */
export function dnsResolver(): dns.promises.Resolver {
  if (!resolver) {
    resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    const servers = (env().DNS_SERVERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length) resolver.setServers(servers);
  }
  return resolver;
}

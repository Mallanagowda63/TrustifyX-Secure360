import dns from "node:dns";
import { parse as parseDomain } from "tldts";
import { dnsResolver } from "../security/dns-resolver";

export interface DnsInfo {
  hostname: string;
  registrableDomain: string;
  A: string[];
  AAAA: string[];
  CNAME: string[];
  NS: string[];
  MX: string[];
  CAA: string[];
  spf: string | null;
  dmarc: string | null;
}

type DnsResolver = Pick<
  dns.promises.Resolver,
  "resolve4" | "resolve6" | "resolveCname" | "resolveNs" | "resolveMx" | "resolveCaa" | "resolveTxt"
>;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return fallback;
    throw err;
  }
}

const sorted = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort();

export async function collectDns(hostname: string, r: DnsResolver = dnsResolver()): Promise<DnsInfo> {
  const registrableDomain = parseDomain(hostname, { allowPrivateDomains: true }).domain ?? hostname;
  const [A, AAAA, CNAME, NS, MX, CAA, txt, dmarcTxt] = await Promise.all([
    safe(() => r.resolve4(hostname), [] as string[]),
    safe(() => r.resolve6(hostname), [] as string[]),
    safe(() => r.resolveCname(hostname), [] as string[]),
    safe(() => r.resolveNs(registrableDomain), [] as string[]),
    safe(async () => (await r.resolveMx(registrableDomain)).map((m) => `${m.priority} ${m.exchange || "."}`), [] as string[]),
    safe(
      async () =>
        (await r.resolveCaa(registrableDomain)).map((c) => {
          const tag =
            c.issue !== undefined ? "issue" : c.issuewild !== undefined ? "issuewild" : c.iodef !== undefined ? "iodef" : "other";
          const value = c.issue ?? c.issuewild ?? c.iodef ?? "";
          return `${c.critical} ${tag} "${value}"`;
        }),
      [] as string[],
    ),
    safe(() => r.resolveTxt(registrableDomain), [] as string[][]),
    safe(() => r.resolveTxt(`_dmarc.${registrableDomain}`), [] as string[][]),
  ]);
  const spf = txt.map((c) => c.join("")).find((t) => t.toLowerCase().startsWith("v=spf1")) ?? null;
  const dmarc = dmarcTxt.map((c) => c.join("")).find((t) => t.toLowerCase().startsWith("v=dmarc1")) ?? null;
  return {
    hostname,
    registrableDomain,
    A: sorted(A),
    AAAA: sorted(AAAA),
    CNAME: sorted(CNAME),
    NS: sorted(NS),
    MX: sorted(MX),
    CAA: sorted(CAA),
    spf: spf?.slice(0, 500) ?? null,
    dmarc: dmarc?.slice(0, 500) ?? null,
  };
}

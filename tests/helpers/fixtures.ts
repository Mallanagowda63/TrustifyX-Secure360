import type { ConfigObservation } from "@/server/monitoring/types";
import type { TlsInfo } from "@/server/monitoring/tls";
import { analyzeHeaders } from "@/server/monitoring/headers";

// Fixed per test run so two fixtures built moments apart compare equal.
const BASE = Date.now();

export function tls(overrides: Partial<TlsInfo> = {}): TlsInfo {
  const validTo = new Date(BASE + 90 * 86_400_000);
  return {
    authorized: true,
    authorizationError: null,
    hostnameMatches: true,
    protocol: "TLSv1.3",
    cipher: "TLS_AES_256_GCM_SHA384",
    subjectCN: "example.com",
    subjectAltNames: ["example.com", "www.example.com"],
    issuer: "Let's Encrypt",
    validFrom: new Date(BASE - 10 * 86_400_000).toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining: 90,
    expired: false,
    serialNumber: "ABC123",
    fingerprint256: "AA:BB:CC",
    remoteAddress: "93.184.216.34",
    ...overrides,
  };
}

export const HARDENED_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  server: "nginx",
};

/** A fully hardened site: no rule should fire. */
export function hardenedObservation(overrides: Partial<ConfigObservation> = {}): ConfigObservation {
  return {
    tls: tls(),
    headers: analyzeHeaders("https://example.com/", 200, { ...HARDENED_HEADERS }),
    https: { httpReachable: true, redirectsToHttps: true, finalIsHttps: true, firstStatus: 301, firstLocation: "https://example.com/", finalUrl: "https://example.com/", error: null },
    dns: {
      hostname: "example.com",
      registrableDomain: "example.com",
      A: ["93.184.216.34"],
      AAAA: [],
      CNAME: [],
      NS: ["a.iana-servers.net", "b.iana-servers.net"],
      MX: ["10 mail.example.com"],
      CAA: ['0 issue "letsencrypt.org"'],
      spf: "v=spf1 -all",
      dmarc: "v=DMARC1; p=reject",
    },
    errors: {},
    ...overrides,
  };
}

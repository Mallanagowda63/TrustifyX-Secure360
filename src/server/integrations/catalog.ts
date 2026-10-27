import type { IntegrationStatus, IntegrationType } from "@prisma/client";
import { prisma } from "../db";

export interface IntegrationDefinition {
  type: IntegrationType;
  name: string;
  summary: string;
  provides: string[];
  requires: string[];
  /** Integrations are opt-in and separate from basic URL monitoring. */
  availability: "planned" | "available";
  /** Portal page that manages an available connector. */
  href?: string;
}

/**
 * Advanced integrations (design: docs/INTEGRATIONS.md). They are kept separate from the basic
 * external URL monitoring: each needs explicit customer credentials or agents, stores
 * credentials encrypted (AES-256-GCM, src/server/security/crypto.ts), and shows data only
 * from its own source. Until a connector is implemented its status is NOT_CONNECTED and
 * no numbers are displayed.
 */
export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    type: "CLOUDFLARE_WAF",
    name: "Cloudflare WAF",
    summary: "Connect your Cloudflare account to manage protection for verified websites and import real security events.",
    provides: ["Reviewed, verified protection settings and TrustifyX-managed firewall rules", "Security events by action, rule and country", "Edge DDoS / proxy status and origin-exposure warnings"],
    requires: ["Scoped Cloudflare API token (no password or Global API Key)", "Zone matching a verified website", "Secure360 Protect add-on"],
    availability: "available",
    href: "/protection",
  },
  {
    type: "WAZUH",
    name: "Wazuh server security",
    summary: "Install the Wazuh agent on servers you control to receive file-integrity, malware-related and security-log alerts.",
    provides: ["Agent connectivity status", "File integrity monitoring alerts", "Rootkit / malware-related alerts where detectors are configured"],
    requires: ["Root/administrator access to a VPS, cloud VM or dedicated server (not shared hosting)", "TrustifyX Wazuh manager configured (deploy/)", "Business plan or Secure360 Protect add-on"],
    availability: "available",
    href: "/servers",
  },
  {
    type: "GITHUB",
    name: "GitHub",
    summary: "Read repository security signals for the code behind your websites.",
    provides: ["Dependabot alerts", "Code-scanning (CodeQL) alerts", "Secret-scanning alerts and branch-protection status"],
    requires: ["GitHub App installation with read-only security-events permission"],
    availability: "planned",
  },
  {
    type: "OWASP_ZAP",
    name: "OWASP ZAP scanning",
    summary: "Run authorized OWASP ZAP scans of your verified websites from an isolated scanner.",
    provides: ["Passive baseline scans (no attack payloads), on demand or scheduled", "Optional active scans in a maintenance window (Business plan)", "Findings with evidence, remediation and downloadable reports"],
    requires: ["Verified website ownership", "Explicit authorization per scan or schedule", "Isolated scanner container deployed (deploy/)"],
    availability: "available",
    href: "/scans",
  },
];

export async function listIntegrations(orgId: string) {
  const rows = await prisma.integration.findMany({ where: { orgId }, select: { type: true, status: true, lastSyncAt: true, lastError: true } });
  const byType = new Map(rows.map((r) => [r.type, r]));
  return INTEGRATIONS.map((d) => {
    const row = byType.get(d.type);
    return {
      ...d,
      status: (row?.status ?? "NOT_CONNECTED") as IntegrationStatus,
      lastSyncAt: row?.lastSyncAt ?? null,
      lastError: row?.lastError ?? null,
    };
  });
}

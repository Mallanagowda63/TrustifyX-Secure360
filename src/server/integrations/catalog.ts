import type { IntegrationStatus, IntegrationType } from "@prisma/client";
import { prisma } from "../db";

export interface IntegrationDefinition {
  type: IntegrationType;
  name: string;
  summary: string;
  provides: string[];
  requires: string[];
  /** Integrations are opt-in and separate from basic URL monitoring. */
  availability: "planned";
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
    summary: "Import firewall events and security-level settings for zones you own on Cloudflare.",
    provides: ["WAF / managed-rule events by action and rule", "Rate-limiting and bot-management events", "Security level and SSL/TLS mode changes"],
    requires: ["Scoped API token with Zone:Read and Analytics:Read", "Zone matching a verified website"],
    availability: "planned",
  },
  {
    type: "WAZUH",
    name: "Wazuh",
    summary: "Receive security alerts from your Wazuh manager about servers running the Wazuh agent.",
    provides: ["Host intrusion detection alerts", "File-integrity monitoring events", "Vulnerability detector results reported by your Wazuh manager"],
    requires: ["Wazuh manager API URL and read-only API user", "Agents installed on your servers"],
    availability: "planned",
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
    name: "OWASP ZAP baseline",
    summary: "Run an authorized, passive ZAP baseline scan against a verified website on request.",
    provides: ["Passive scan alerts (no attack payloads)", "Comparison with previous baseline runs"],
    requires: ["Verified website ownership", "Separate written authorization per scan", "Isolated scanner worker with egress restrictions"],
    availability: "planned",
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

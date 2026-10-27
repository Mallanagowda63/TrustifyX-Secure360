import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { audit } from "../audit";
import { ApiError } from "../api";
import { decryptSecret, encryptSecret, randomToken } from "../security/crypto";
import { getEntitlement, addonEntitlement } from "../billing/entitlements";
import { ADDON_PROTECT } from "../billing/plans";
import { assertCan, type Actor } from "../services/actor";
import { addAgent, deleteAgent, getAgents, searchAlerts, wazuhConfigured, wazuhEventsConfigured, WazuhError, type WazuhAlert } from "../integrations/wazuh/client";

export type Environment = "VPS" | "DEDICATED" | "CLOUD_VM" | "SHARED_HOSTING";
export type ServerOs = "LINUX_DEB" | "LINUX_RPM" | "WINDOWS" | "MACOS";

export const MAX_AGENTS = 5;
const ACTIVE_WINDOW_MS = 15 * 60_000;

// ─────────────────────────────── pure helpers ───────────────────────────────

/** Wazuh rule level (0-15) → severity. Levels per https://documentation.wazuh.com/current/user-manual/ruleset/rules/rules-classification.html */
export function severityFor(level: number): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" {
  if (level >= 13) return "CRITICAL";
  if (level >= 10) return "HIGH";
  if (level >= 7) return "MEDIUM";
  if (level >= 4) return "LOW";
  return "INFO";
}

export function categoryFor(groups: string[]): "FILE_INTEGRITY" | "MALWARE" | "ROOTKIT" | "AUTHENTICATION" | "SECURITY_LOG" {
  const g = groups.map((x) => x.toLowerCase());
  if (g.some((x) => ["virustotal", "yara", "malware", "clamd", "windows_defender", "virus"].includes(x))) return "MALWARE";
  if (g.includes("rootcheck")) return "ROOTKIT";
  if (g.some((x) => x.startsWith("syscheck"))) return "FILE_INTEGRITY";
  if (g.some((x) => x.startsWith("authentication") || ["sshd", "pam", "win_authentication"].includes(x))) return "AUTHENTICATION";
  return "SECURITY_LOG";
}

export function toEventRow(orgId: string, agentRefId: string, a: WazuhAlert): Prisma.ServerSecurityEventCreateManyInput | null {
  const at = a.timestamp ? new Date(a.timestamp) : null;
  if (!a.id || !at || Number.isNaN(at.getTime())) return null;
  const level = Math.max(0, Math.min(15, Number(a.rule?.level ?? 0) || 0));
  const groups = Array.isArray(a.rule?.groups) ? a.rule!.groups!.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  const cut = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
  return {
    orgId,
    agentRefId,
    eventKey: String(a.id).slice(0, 100),
    occurredAt: at,
    ruleId: cut(a.rule?.id, 20),
    level,
    severity: severityFor(level),
    category: categoryFor(groups),
    description: cut(a.rule?.description, 500) ?? "Wazuh alert",
    groups,
    filePath: cut(a.syscheck?.path, 1000),
    fileEvent: cut(a.syscheck?.event, 40),
    location: cut(a.location, 300),
    logExcerpt: cut(a.full_log, 1000),
  };
}

/** Step-by-step agent installation for the official Wazuh packages, then importing the TrustifyX key. */
export function installInstructions(os: ServerOs, manager: string, key: string) {
  const docs = "https://documentation.wazuh.com/current/installation-guide/wazuh-agent/index.html";
  switch (os) {
    case "LINUX_DEB":
      return {
        docs,
        steps: [
          { title: "Add the official Wazuh repository", text: "Follow the Wazuh agent guide for Debian/Ubuntu to add the repository and its signing key.", command: null },
          { title: "Install the agent pointing at TrustifyX", text: "Run as root:", command: `WAZUH_MANAGER="${manager}" apt-get install wazuh-agent` },
          { title: "Import your TrustifyX agent key", text: "This links the server to your organization only.", command: `/var/ossec/bin/manage_agents -i ${key}` },
          { title: "Start the agent", text: "", command: "systemctl daemon-reload && systemctl enable wazuh-agent && systemctl start wazuh-agent" },
        ],
      };
    case "LINUX_RPM":
      return {
        docs,
        steps: [
          { title: "Add the official Wazuh repository", text: "Follow the Wazuh agent guide for RHEL/CentOS/Amazon Linux to add the repository.", command: null },
          { title: "Install the agent pointing at TrustifyX", text: "Run as root (dnf on newer systems):", command: `WAZUH_MANAGER="${manager}" yum install wazuh-agent` },
          { title: "Import your TrustifyX agent key", text: "This links the server to your organization only.", command: `/var/ossec/bin/manage_agents -i ${key}` },
          { title: "Start the agent", text: "", command: "systemctl daemon-reload && systemctl enable wazuh-agent && systemctl start wazuh-agent" },
        ],
      };
    case "WINDOWS":
      return {
        docs,
        steps: [
          { title: "Download the Wazuh agent MSI", text: "Download the current agent installer from the official Wazuh documentation.", command: null },
          { title: "Install quietly, pointing at TrustifyX", text: "In an administrator command prompt, in the download folder:", command: `msiexec.exe /i wazuh-agent-<version>.msi /q WAZUH_MANAGER="${manager}"` },
          { title: "Import your TrustifyX agent key", text: "Administrator command prompt (64-bit Windows):", command: `"C:\\Program Files (x86)\\ossec-agent\\manage_agents.exe" -i ${key}` },
          { title: "Start the agent", text: "PowerShell:", command: "Start-Service wazuhsvc" },
        ],
      };
    case "MACOS":
      return {
        docs,
        steps: [
          { title: "Install the Wazuh agent package", text: "Install the official macOS package from the Wazuh documentation and set the manager address to the one below.", command: `Manager address: ${manager}` },
          { title: "Import your TrustifyX agent key", text: "Run as root:", command: `/Library/Ossec/bin/manage_agents -i ${key}` },
          { title: "Restart the agent", text: "", command: "/Library/Ossec/bin/wazuh-control restart" },
        ],
      };
  }
}

// ─────────────────────────────── access ───────────────────────────────

export async function serverAccess(orgId: string) {
  const [ent, addon] = await Promise.all([getEntitlement(orgId), addonEntitlement(orgId, ADDON_PROTECT)]);
  const allowed = ent.active && (ent.plan?.code === "BUSINESS" || addon.active);
  return { allowed, configured: wazuhConfigured(), eventsConfigured: wazuhEventsConfigured(), reason: allowed ? null : "Server security is included in the Business plan and the Secure360 Protect add-on." };
}

// ─────────────────────────────── commands ───────────────────────────────

export async function registerServer(actor: Actor, input: { displayName: string; environment: Environment; os: ServerOs }) {
  assertCan(actor, "server.manage");
  const name = input.displayName.trim().slice(0, 80);
  if (!name) throw new ApiError(400, "Give the server a name", "validation");
  if (input.environment === "SHARED_HOSTING") {
    // Recorded so the dashboard can explain the limitation; nothing is registered with Wazuh.
    const row = await prisma.serverAgent.create({ data: { orgId: actor.orgId, displayName: name, environment: input.environment, os: input.os, status: "NOT_COMPATIBLE", createdById: actor.userId } });
    return { server: row, compatible: false as const };
  }
  const access = await serverAccess(actor.orgId);
  if (!access.allowed) throw new ApiError(402, access.reason!, "plan_limit");
  if (!access.configured) throw new ApiError(503, "Server monitoring is awaiting live configuration of the TrustifyX Wazuh manager.", "wazuh_not_configured");
  const count = await prisma.serverAgent.count({ where: { orgId: actor.orgId, status: { notIn: ["REMOVED", "NOT_COMPATIBLE"] } } });
  if (count >= MAX_AGENTS) throw new ApiError(402, `Up to ${MAX_AGENTS} servers can be monitored.`, "plan_limit");

  // Unique, non-guessable name; the agent ID returned by Wazuh is what ties the server to this organization.
  const wazuhName = `tx-${actor.orgId.slice(-8)}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  let reg: { id: string; key: string };
  try {
    reg = await addAgent(wazuhName);
  } catch (err) {
    throw new ApiError(502, err instanceof WazuhError ? err.message : "Could not register the server with the Wazuh manager", "wazuh_error");
  }
  const row = await prisma.serverAgent.create({
    data: {
      orgId: actor.orgId,
      displayName: name,
      environment: input.environment,
      os: input.os,
      status: "PENDING_INSTALL",
      wazuhAgentId: reg.id,
      wazuhAgentName: wazuhName,
      keyEnc: encryptSecret(reg.key),
      createdById: actor.userId,
    },
  });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "server.registered", targetType: "server_agent", targetId: row.id, metadata: { wazuhAgentId: reg.id, os: input.os } });
  return { server: row, compatible: true as const, install: installInstructions(input.os, env().WAZUH_MANAGER_ADDRESS!, reg.key) };
}

/** Install steps (with the key) are only available until the agent first connects. */
export async function installFor(actor: Actor, serverId: string) {
  assertCan(actor, "server.manage");
  const s = await prisma.serverAgent.findFirst({ where: { id: serverId, orgId: actor.orgId } });
  if (!s) throw new ApiError(404, "Server not found", "not_found");
  if (!s.keyEnc) throw new ApiError(400, "This agent is already connected; its key is no longer shown.", "key_consumed");
  return installInstructions(s.os as ServerOs, env().WAZUH_MANAGER_ADDRESS ?? "<manager address>", decryptSecret(s.keyEnc));
}

export async function removeServer(actor: Actor, serverId: string) {
  assertCan(actor, "server.manage");
  const s = await prisma.serverAgent.findFirst({ where: { id: serverId, orgId: actor.orgId } });
  if (!s) throw new ApiError(404, "Server not found", "not_found");
  if (s.wazuhAgentId && s.status !== "REMOVED") {
    try {
      await deleteAgent(s.wazuhAgentId);
    } catch (err) {
      if (!(err instanceof WazuhError && err.status === 404)) throw new ApiError(502, "Could not remove the agent from the Wazuh manager. Try again.", "wazuh_error");
    }
  }
  // Removal deletes imported events too (customer integration removal). Nothing on the server itself is touched.
  await prisma.serverAgent.delete({ where: { id: s.id } });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "server.removed", targetType: "server_agent", targetId: s.id, metadata: { wazuhAgentId: s.wazuhAgentId } });
  return { ok: true, uninstallHint: "Uninstall the Wazuh agent package from the server to stop it from trying to connect." };
}

// ─────────────────────────────── worker sync ───────────────────────────────

/** Updates agent connectivity and imports new alerts (worker, every 10 minutes). Read-only towards customer servers. */
export async function syncServers(now = new Date()) {
  if (!wazuhConfigured()) return { skipped: "not_configured" };
  const agents = await prisma.serverAgent.findMany({ where: { wazuhAgentId: { not: null }, status: { notIn: ["REMOVED", "NOT_COMPATIBLE"] } } });
  if (!agents.length) return { agents: 0 };
  const infos = new Map<string, Awaited<ReturnType<typeof getAgents>>[number]>();
  for (let i = 0; i < agents.length; i += 200) {
    for (const info of await getAgents(agents.slice(i, i + 200).map((a) => a.wazuhAgentId!))) infos.set(String(info.id), info);
  }
  let imported = 0;
  for (const a of agents) {
    const info = infos.get(a.wazuhAgentId!);
    const keepAlive = info?.lastKeepAlive ? new Date(info.lastKeepAlive) : null;
    const status = !info
      ? "REMOVED"
      : info.status === "active" && keepAlive && now.getTime() - keepAlive.getTime() < ACTIVE_WINDOW_MS
        ? "ACTIVE"
        : info.status === "never_connected" || info.status === "pending"
          ? "PENDING_INSTALL"
          : "DISCONNECTED";
    const data: Prisma.ServerAgentUpdateInput = {
      status,
      lastKeepAlive: keepAlive && !Number.isNaN(keepAlive.getTime()) ? keepAlive : null,
      agentVersion: info?.version?.slice(0, 40) ?? a.agentVersion,
      osName: [info?.os?.name, info?.os?.version].filter(Boolean).join(" ").slice(0, 80) || a.osName,
      lastSyncError: info ? null : "The agent no longer exists on the Wazuh manager.",
    };
    if (status === "ACTIVE" && !a.firstSeenAt) {
      data.firstSeenAt = now;
      data.keyEnc = null; // key no longer needed once the agent is connected
    }
    await prisma.serverAgent.update({ where: { id: a.id }, data });
    if (wazuhEventsConfigured() && (status === "ACTIVE" || a.firstSeenAt)) {
      try {
        imported += await importAlerts(a.id, a.orgId, a.wazuhAgentId!, a.eventsSyncedUntil ?? a.createdAt);
      } catch (err) {
        await prisma.serverAgent.update({ where: { id: a.id }, data: { lastSyncError: (err as Error).message.slice(0, 300) } });
      }
    }
  }
  return { agents: agents.length, imported };
}

async function importAlerts(agentRefId: string, orgId: string, wazuhAgentId: string, since: Date) {
  let cursor = since;
  let total = 0;
  for (let page = 0; page < 5; page++) {
    const alerts = await searchAlerts([wazuhAgentId], cursor, 500);
    // Defence in depth: only alerts that really belong to this agent.
    const rows = alerts.filter((x) => String(x.agent?.id ?? "") === wazuhAgentId).map((x) => toEventRow(orgId, agentRefId, x)).filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) total += (await prisma.serverSecurityEvent.createMany({ data: rows, skipDuplicates: true })).count;
    const last = rows.length ? (rows[rows.length - 1].occurredAt as Date) : null;
    if (last && last > cursor) cursor = last;
    if (alerts.length < 500 || !last) break;
  }
  await prisma.serverAgent.update({
    where: { id: agentRefId },
    data: { eventsSyncedUntil: cursor, ...(total ? { lastEventAt: cursor } : {}), lastSyncError: null },
  });
  return total;
}

// ─────────────────────────────── read ───────────────────────────────

export async function serverOverview(orgId: string) {
  const [access, servers, events, bySeverity, byCategory] = await Promise.all([
    serverAccess(orgId),
    prisma.serverAgent.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" },
      select: { id: true, displayName: true, environment: true, os: true, status: true, wazuhAgentId: true, agentVersion: true, osName: true, lastKeepAlive: true, firstSeenAt: true, lastEventAt: true, lastSyncError: true, createdAt: true, keyEnc: true },
    }),
    prisma.serverSecurityEvent.findMany({
      where: { orgId },
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: { id: true, occurredAt: true, severity: true, level: true, category: true, description: true, filePath: true, fileEvent: true, ruleId: true, agent: { select: { displayName: true } } },
    }),
    prisma.serverSecurityEvent.groupBy({ by: ["severity"], where: { orgId, occurredAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
    prisma.serverSecurityEvent.groupBy({ by: ["category"], where: { orgId, occurredAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true } }),
  ]);
  return {
    access,
    servers: servers.map(({ keyEnc, ...s }) => ({ ...s, installAvailable: Boolean(keyEnc), sendingData: s.status === "ACTIVE" && Boolean(s.firstSeenAt) })),
    events,
    last7Days: {
      bySeverity: Object.fromEntries(bySeverity.map((x) => [x.severity, x._count._all])),
      byCategory: Object.fromEntries(byCategory.map((x) => [x.category, x._count._all])),
    },
  };
}

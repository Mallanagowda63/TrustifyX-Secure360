import type { CloudflareConnection, CloudflareZone, Prisma, ProtectionConfiguration } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { ApiError } from "../api";
import { decryptSecret, encryptSecret, sha256 } from "../security/crypto";
import { rateLimit } from "../security/rate-limit";
import { addonEntitlement } from "../billing/entitlements";
import { ADDON_PROTECT } from "../billing/plans";
import { assertCan, type Actor } from "../services/actor";
import { CloudflareApiError, CloudflareClient, type CfDnsRecord, type CfRule, type CfRuleset } from "../integrations/cloudflare/client";
import {
  CUSTOM_RULE_LIMIT,
  FEATURES,
  MANAGED_RULESET_ID,
  MANAGED_RULESET_NAME,
  PHASE_CUSTOM,
  PHASE_MANAGED,
  RULE_PREFIX,
  featureByKey,
  normalizePlan,
  planAvailability,
  ruleDescription,
  type CfPlan,
  type ProtectionFeature,
} from "./features";
import { syncZoneEvents } from "./events";

const json = (v: unknown) => v as Prisma.InputJsonValue;

// ─────────────────────────────── access ───────────────────────────────

export async function protectionAccess(orgId: string) {
  const a = await addonEntitlement(orgId, ADDON_PROTECT);
  return { protect: a.active, baseActive: a.baseActive, accessUntil: a.accessUntil };
}

async function requireProtect(orgId: string) {
  const a = await protectionAccess(orgId);
  if (!a.baseActive) throw new ApiError(402, "An active Secure360 plan is required.", "subscription_required");
  if (!a.protect) throw new ApiError(402, "Website protection requires the Secure360 Protect add-on.", "protect_required");
}

// ─────────────────────────────── helpers ───────────────────────────────

/** A zone covers a hostname when the hostname is the zone apex or one of its subdomains. */
export function zoneMatchesHost(zoneName: string, hostname: string): boolean {
  const z = zoneName.toLowerCase().replace(/\.$/, "");
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === z || h.endsWith(`.${z}`);
}

async function getConnection(orgId: string) {
  const conn = await prisma.cloudflareConnection.findUnique({ where: { orgId } });
  if (!conn) throw new ApiError(404, "Cloudflare is not connected", "not_connected");
  return conn;
}

const clientFor = (conn: Pick<CloudflareConnection, "tokenEnc">) => new CloudflareClient(decryptSecret(conn.tokenEnc));

async function loadZone(orgId: string, zoneRefId: string) {
  const zone = await prisma.cloudflareZone.findFirst({ where: { id: zoneRefId, orgId }, include: { connection: true, website: true } });
  if (!zone) throw new ApiError(404, "Protected zone not found", "not_found");
  return zone;
}

/** Turns Cloudflare API failures into customer-facing messages. Marks the connection invalid on auth errors. */
async function cfFailure(err: unknown, connectionId: string | null, permission?: string): Promise<ApiError> {
  if (err instanceof CloudflareApiError) {
    if (err.status === 401 || (err.status === 403 && /invalid|expired|disabled/i.test(err.message))) {
      if (connectionId) await prisma.cloudflareConnection.update({ where: { id: connectionId }, data: { status: "INVALID", lastError: err.message.slice(0, 500) } }).catch(() => undefined);
      return new ApiError(400, "Cloudflare rejected the connected API token. Replace the token in Firewall & Protection.", "cloudflare_token_invalid");
    }
    if (err.status === 403) {
      return new ApiError(403, `Cloudflare refused this change. The token may lack the "${permission ?? "required"}" permission, or your Cloudflare plan does not include it.`, "cloudflare_forbidden");
    }
    return new ApiError(502, `Cloudflare API error: ${err.message.slice(0, 300)}`, "cloudflare_error");
  }
  if (err instanceof ApiError) return err;
  return new ApiError(502, `Cloudflare request failed: ${(err as Error).message.slice(0, 300)}`, "cloudflare_error");
}

async function changeAudit(input: {
  orgId: string;
  zoneRefId?: string | null;
  feature: string;
  action: string;
  result: "SUCCEEDED" | "FAILED" | "VERIFY_FAILED";
  before?: unknown;
  after?: unknown;
  error?: string;
  userId?: string | null;
  ip?: string | null;
}) {
  await prisma.protectionChangeAudit.create({
    data: {
      orgId: input.orgId,
      zoneRefId: input.zoneRefId ?? null,
      feature: input.feature,
      action: input.action,
      result: input.result,
      before: input.before === undefined ? undefined : json(input.before),
      after: input.after === undefined ? undefined : json(input.after),
      error: input.error?.slice(0, 500),
      userId: input.userId ?? null,
      ip: input.ip ?? null,
    },
  });
}

async function setIntegrationStatus(orgId: string, status: "CONNECTED" | "NOT_CONNECTED" | "ERROR", lastError: string | null = null) {
  await prisma.integration.upsert({
    where: { orgId_type: { orgId, type: "CLOUDFLARE_WAF" } },
    create: { orgId, type: "CLOUDFLARE_WAF", status, lastError, lastSyncAt: new Date() },
    update: { status, lastError, lastSyncAt: new Date() },
  });
}

// ─────────────────────────────── connect & discover ───────────────────────────────

/**
 * Connects (or replaces) the organization's Cloudflare API token. The token is verified with
 * Cloudflare, must be able to list zones, and is stored encrypted. Nothing is changed in Cloudflare.
 */
export async function connectCloudflare(actor: Actor, token: string) {
  assertCan(actor, "protection.manage");
  await requireProtect(actor.orgId);
  const rl = await rateLimit(`cf:connect:${actor.orgId}`, 10, 3600);
  if (!rl.allowed) throw new ApiError(429, "Too many attempts. Please try again later.", "rate_limited");
  const trimmed = token.trim();
  let client: CloudflareClient;
  try {
    client = new CloudflareClient(trimmed);
  } catch {
    throw new ApiError(400, "That does not look like a Cloudflare API token. Create one under My Profile → API Tokens in Cloudflare.", "invalid_token_format");
  }

  let verified: Awaited<ReturnType<CloudflareClient["verifyToken"]>>;
  try {
    verified = await client.verifyToken();
  } catch (err) {
    await changeAudit({ orgId: actor.orgId, feature: "connection", action: "CONNECT", result: "FAILED", error: (err as Error).message, userId: actor.userId, ip: actor.ip });
    if (err instanceof CloudflareApiError && (err.status === 400 || err.status === 401 || err.status === 403)) {
      throw new ApiError(400, "Cloudflare did not accept this token. Check that it was copied completely and is not expired.", "cloudflare_token_invalid");
    }
    throw await cfFailure(err, null);
  }
  if (verified.status !== "active") throw new ApiError(400, `This Cloudflare token is ${verified.status}. Create an active token.`, "cloudflare_token_invalid");

  let zones;
  try {
    zones = await client.listZones();
  } catch (err) {
    throw err instanceof CloudflareApiError && err.status === 403
      ? new ApiError(400, 'The token cannot list zones. Add the "Zone Read" permission for your zone.', "cloudflare_missing_permission")
      : await cfFailure(err, null);
  }

  const data = {
    tokenEnc: encryptSecret(trimmed),
    tokenHint: trimmed.slice(-4),
    cfTokenId: verified.id ?? null,
    status: "ACTIVE",
    tokenExpiresAt: verified.expires_on ? new Date(verified.expires_on) : null,
    lastVerifiedAt: new Date(),
    lastError: null,
    permissions: json({ zoneRead: true }),
  };
  const existing = await prisma.cloudflareConnection.findUnique({ where: { orgId: actor.orgId } });
  const conn = existing
    ? await prisma.cloudflareConnection.update({ where: { id: existing.id }, data })
    : await prisma.cloudflareConnection.create({ data: { ...data, orgId: actor.orgId, createdById: actor.userId } });
  await setIntegrationStatus(actor.orgId, "CONNECTED");
  await changeAudit({ orgId: actor.orgId, feature: "connection", action: existing ? "REPLACE_TOKEN" : "CONNECT", result: "SUCCEEDED", after: { zones: zones.length, tokenHint: conn.tokenHint }, userId: actor.userId, ip: actor.ip });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: existing ? "cloudflare.token_replaced" : "cloudflare.connected", metadata: { zones: zones.length } });
  return discoverZones(actor);
}

/** Zones visible to the token and the verified websites each one could protect. */
export async function discoverZones(actor: Actor) {
  assertCan(actor, "protection.read");
  const conn = await getConnection(actor.orgId);
  let zones;
  try {
    zones = await clientFor(conn).listZones();
  } catch (err) {
    throw await cfFailure(err, conn.id);
  }
  const websites = await prisma.website.findMany({
    where: { orgId: actor.orgId, verifiedAt: { not: null }, status: { not: "PENDING_VERIFICATION" } },
    select: { id: true, hostname: true, displayName: true, cloudflareZones: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name ?? null })),
    websites: websites.map((w) => ({
      id: w.id,
      hostname: w.hostname,
      displayName: w.displayName,
      linkedZone: w.cloudflareZones[0] ?? null,
      // Most specific zone first (sub.example.com before example.com).
      candidates: zones.filter((z) => zoneMatchesHost(z.name, w.hostname)).sort((a, b) => b.name.length - a.name.length).map((z) => z.id),
    })),
  };
}

/** Links a verified website to the Cloudflare zone that serves it. Read-only for Cloudflare. */
export async function linkZone(actor: Actor, websiteId: string, cfZoneId: string) {
  assertCan(actor, "protection.manage");
  await requireProtect(actor.orgId);
  const conn = await getConnection(actor.orgId);
  const website = await prisma.website.findFirst({ where: { id: websiteId, orgId: actor.orgId } });
  if (!website) throw new ApiError(404, "Website not found", "not_found");
  if (!website.verifiedAt || website.status === "PENDING_VERIFICATION") {
    throw new ApiError(400, "Verify ownership of this website before connecting Cloudflare protection.", "website_not_verified");
  }
  let zone;
  try {
    zone = await clientFor(conn).getZone(cfZoneId);
  } catch (err) {
    throw await cfFailure(err, conn.id);
  }
  if (!zoneMatchesHost(zone.name, website.hostname)) {
    throw new ApiError(400, `The Cloudflare zone ${zone.name} does not serve ${website.hostname}. Choose the zone for this website's domain.`, "zone_mismatch");
  }
  const taken = await prisma.cloudflareZone.findFirst({ where: { orgId: actor.orgId, cfZoneId: zone.id } });
  if (taken && taken.websiteId !== website.id) throw new ApiError(409, `This zone is already linked to another website in your organization.`, "zone_in_use");
  const existing = await prisma.cloudflareZone.findUnique({ where: { websiteId: website.id } });
  if (existing && existing.cfZoneId !== zone.id) throw new ApiError(409, "This website is already linked to a different zone. Unlink it first.", "website_linked");

  const plan = normalizePlan(zone.plan?.legacy_id, zone.plan?.name);
  const row =
    existing ??
    (await prisma.cloudflareZone.create({
      data: {
        orgId: actor.orgId,
        connectionId: conn.id,
        websiteId: website.id,
        cfZoneId: zone.id,
        name: zone.name,
        status: zone.status,
        planCode: plan,
        planName: zone.plan?.name ?? null,
        nameServers: json(zone.name_servers ?? []),
        paused: Boolean(zone.paused),
      },
    }));
  await changeAudit({ orgId: actor.orgId, zoneRefId: row.id, feature: "zone", action: "ZONE_LINK", result: "SUCCEEDED", after: { zone: zone.name, website: website.hostname }, userId: actor.userId, ip: actor.ip });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "cloudflare.zone_linked", targetType: "website", targetId: website.id, metadata: { zone: zone.name } });
  return syncZone(row.id);
}

// ─────────────────────────────── observe ───────────────────────────────

export interface ZoneObservation {
  settings: Record<string, unknown>;
  dns: {
    /** Records for the website hostname. */
    hostRecords: Array<{ type: string; name: string; proxied: boolean | null }>;
    /** true = all address records for the hostname are proxied through Cloudflare. */
    proxied: boolean | null;
    /** Unproxied A/AAAA records pointing at the same origin address as the website (origin may be discoverable). */
    exposedRecords: string[];
  } | null;
  customRules: Array<{ id: string | null; description: string; action: string; enabled: boolean; trustifyx: boolean }> | null;
  customRulesetId: string | null;
  managedRulesetAvailable: boolean | null;
  managedDeployed: boolean | null;
  managedRulesetId: string | null;
  botFightMode: boolean | null;
  errors: Record<string, string>;
}

export interface ZoneCapabilities {
  plan: CfPlan;
  permissions: { settingsRead: boolean; dnsRead: boolean; wafRead: boolean; botsRead: boolean };
  customRuleLimit: number;
  customRulesUsed: number | null;
  logActionAvailable: boolean;
}

async function probe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; forbidden: boolean }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200), forbidden: err instanceof CloudflareApiError && err.status === 403 };
  }
}

const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

export function analyzeDns(records: CfDnsRecord[], hostname: string): NonNullable<ZoneObservation["dns"]> {
  const host = hostname.toLowerCase();
  const hostRecords = records.filter((r) => r.name.toLowerCase() === host && ADDRESS_TYPES.has(r.type));
  const proxied = hostRecords.length ? hostRecords.every((r) => r.proxied === true) : null;
  // Only A/AAAA comparisons are reliable: another unproxied name resolving to the same origin IP
  // reveals the origin and lets attackers bypass Cloudflare.
  const originIps = new Set(hostRecords.filter((r) => r.type === "A" || r.type === "AAAA").map((r) => r.content));
  const exposedRecords = records
    .filter((r) => (r.type === "A" || r.type === "AAAA") && r.proxied === false && originIps.has(r.content) && r.name.toLowerCase() !== host)
    .map((r) => r.name);
  return {
    hostRecords: hostRecords.map((r) => ({ type: r.type, name: r.name, proxied: typeof r.proxied === "boolean" ? r.proxied : null })),
    proxied,
    exposedRecords: [...new Set(exposedRecords)],
  };
}

function summarizeRules(rs: CfRuleset | null) {
  return (rs?.rules ?? []).map((r) => ({
    id: r.id ?? null,
    description: (r.description ?? "").slice(0, 200),
    action: r.action,
    enabled: r.enabled !== false,
    trustifyx: (r.description ?? "").startsWith(RULE_PREFIX),
  }));
}

const isManagedExecute = (r: CfRule) => r.action === "execute" && (r.action_parameters as { id?: string } | undefined)?.id === MANAGED_RULESET_ID;

async function observe(client: CloudflareClient, cfZoneId: string, hostname: string) {
  const errors: Record<string, string> = {};
  const settings: Record<string, unknown> = {};
  let settingsRead = false;
  for (const id of ["always_use_https", "min_tls_version", "ssl", "security_level"]) {
    const r = await probe(() => client.getSetting(cfZoneId, id));
    if (r.ok) {
      settings[id] = r.value.value;
      settingsRead = true;
    } else errors[`setting:${id}`] = r.error;
  }
  const dnsR = await probe(() => client.listDnsRecords(cfZoneId));
  const customR = await probe(() => client.getEntrypoint(cfZoneId, PHASE_CUSTOM));
  const managedR = await probe(() => client.getEntrypoint(cfZoneId, PHASE_MANAGED));
  const rulesetsR = await probe(() => client.listRulesets(cfZoneId));
  const botR = await probe(() => client.getBotManagement(cfZoneId));
  for (const [k, r] of Object.entries({ dns: dnsR, waf: customR, managed: managedR, rulesets: rulesetsR, bots: botR })) if (!r.ok) errors[k] = r.error;

  const custom = customR.ok ? customR.value : null;
  const managed = managedR.ok ? managedR.value : null;
  const observation: ZoneObservation = {
    settings,
    dns: dnsR.ok ? analyzeDns(dnsR.value, hostname) : null,
    customRules: customR.ok ? summarizeRules(custom) : null,
    customRulesetId: custom?.id ?? null,
    managedRulesetAvailable: rulesetsR.ok
      ? rulesetsR.value.some((r) => r.id === MANAGED_RULESET_ID || (r.kind === "managed" && r.name === MANAGED_RULESET_NAME))
      : null,
    managedDeployed: managedR.ok ? (managed?.rules ?? []).some((r) => isManagedExecute(r) && r.enabled !== false) : null,
    managedRulesetId: managed?.id ?? null,
    botFightMode: botR.ok ? (typeof botR.value.fight_mode === "boolean" ? (botR.value.fight_mode as boolean) : null) : null,
    errors,
  };
  return {
    observation,
    permissions: { settingsRead, dnsRead: dnsR.ok, wafRead: customR.ok, botsRead: botR.ok },
  };
}

/** Re-reads zone status, capabilities and current configuration from Cloudflare. Never writes. */
export async function syncZone(zoneRefId: string) {
  const zone = await prisma.cloudflareZone.findUniqueOrThrow({ where: { id: zoneRefId }, include: { connection: true, website: true } });
  const client = clientFor(zone.connection);
  try {
    const z = await client.getZone(zone.cfZoneId);
    const plan = normalizePlan(z.plan?.legacy_id, z.plan?.name);
    const { observation, permissions } = await observe(client, zone.cfZoneId, zone.website.hostname);
    const capabilities: ZoneCapabilities = {
      plan,
      permissions,
      customRuleLimit: CUSTOM_RULE_LIMIT[plan],
      customRulesUsed: observation.customRules ? observation.customRules.length : null,
      logActionAvailable: plan === "enterprise",
    };
    await prisma.cloudflareZone.update({
      where: { id: zone.id },
      data: {
        name: z.name,
        status: z.status,
        planCode: plan,
        planName: z.plan?.name ?? null,
        nameServers: json(z.name_servers ?? []),
        paused: Boolean(z.paused),
        capabilities: json(capabilities),
        observed: json(observation),
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });
    await prisma.cloudflareConnection.update({ where: { id: zone.connectionId }, data: { status: "ACTIVE", lastVerifiedAt: new Date(), lastError: null } });
    await reconcileConfigs(zone.id, observation);
  } catch (err) {
    const failure = await cfFailure(err, zone.connectionId);
    await prisma.cloudflareZone.update({ where: { id: zone.id }, data: { lastSyncError: failure.message.slice(0, 500), lastSyncedAt: new Date() } });
    throw failure;
  }
  return prisma.cloudflareZone.findUniqueOrThrow({ where: { id: zone.id } });
}

/** Marks TrustifyX-managed rules that someone deleted in Cloudflare (we never re-create them silently). */
async function reconcileConfigs(zoneRefId: string, obs: ZoneObservation) {
  const configs = await prisma.protectionConfiguration.findMany({ where: { zoneRefId, status: { in: ["ACTIVE", "PREVIEW"] }, cfRuleId: { not: null } } });
  for (const c of configs) {
    const f = featureByKey(c.feature);
    const rules = f?.kind === "managed_ruleset" ? null : obs.customRules;
    if (f?.kind === "custom_rule" && rules && !rules.some((r) => r.id === c.cfRuleId)) {
      await prisma.protectionConfiguration.update({ where: { id: c.id }, data: { status: "DISABLED", lastError: "The rule was removed in Cloudflare." } });
    }
  }
}

// ─────────────────────────────── feature status ───────────────────────────────

export type FeatureAvailability = "AVAILABLE" | "UNAVAILABLE_PLAN" | "MISSING_PERMISSION" | "SETUP_REQUIRED";
export type FeatureState = "ENABLED" | "ENABLED_OUTSIDE_TRUSTIFYX" | "PREVIEW" | "NOT_ENABLED" | "UNKNOWN";

export function featureStatus(
  f: ProtectionFeature,
  zone: Pick<CloudflareZone, "status" | "paused" | "capabilities" | "observed">,
  config: Pick<ProtectionConfiguration, "status" | "cfRuleId"> | undefined,
): { availability: FeatureAvailability; reason?: string; state: FeatureState; managedByTrustifyX: boolean } {
  const caps = zone.capabilities as ZoneCapabilities | null;
  const obs = zone.observed as ZoneObservation | null;
  const managedByTrustifyX = Boolean(config && (config.status === "ACTIVE" || config.status === "PREVIEW"));
  if (!caps || !obs) return { availability: "SETUP_REQUIRED", reason: "Zone not synchronised yet.", state: "UNKNOWN", managedByTrustifyX };
  if (zone.status !== "active") return { availability: "SETUP_REQUIRED", reason: `Zone status is "${zone.status}". Finish Cloudflare activation (nameservers) first.`, state: "UNKNOWN", managedByTrustifyX };

  const plan = planAvailability(f, caps.plan);
  let state: FeatureState = "UNKNOWN";
  switch (f.kind) {
    case "setting": {
      const v = obs.settings[f.settingId];
      state = v === undefined ? "UNKNOWN" : f.satisfied(v) ? (managedByTrustifyX ? "ENABLED" : "ENABLED_OUTSIDE_TRUSTIFYX") : "NOT_ENABLED";
      if (!caps.permissions.settingsRead) return { availability: "MISSING_PERMISSION", reason: 'Token needs "Zone Settings Read" and "Zone Settings Edit".', state, managedByTrustifyX };
      break;
    }
    case "bot_fight_mode":
      state = obs.botFightMode === null ? "UNKNOWN" : obs.botFightMode ? (managedByTrustifyX ? "ENABLED" : "ENABLED_OUTSIDE_TRUSTIFYX") : "NOT_ENABLED";
      if (plan.available && !caps.permissions.botsRead) return { availability: "MISSING_PERMISSION", reason: 'Token needs "Bot Management Read" and "Bot Management Edit".', state, managedByTrustifyX };
      break;
    case "managed_ruleset":
      state = obs.managedDeployed === null ? "UNKNOWN" : config?.status === "PREVIEW" ? "PREVIEW" : obs.managedDeployed ? (managedByTrustifyX ? "ENABLED" : "ENABLED_OUTSIDE_TRUSTIFYX") : "NOT_ENABLED";
      if (plan.available && obs.managedRulesetAvailable === false) return { availability: "UNAVAILABLE_PLAN", reason: "Cloudflare does not offer the Managed Ruleset to this zone.", state, managedByTrustifyX };
      if (plan.available && !caps.permissions.wafRead) return { availability: "MISSING_PERMISSION", reason: 'Token needs "Zone WAF Read" and "Zone WAF Edit".', state, managedByTrustifyX };
      break;
    case "custom_rule": {
      const rule = config?.cfRuleId ? obs.customRules?.find((r) => r.id === config.cfRuleId) : undefined;
      state = obs.customRules === null ? "UNKNOWN" : rule ? (rule.enabled ? "ENABLED" : "PREVIEW") : "NOT_ENABLED";
      if (!caps.permissions.wafRead) return { availability: "MISSING_PERMISSION", reason: 'Token needs "Zone WAF Read" and "Zone WAF Edit".', state, managedByTrustifyX };
      if (!rule && caps.customRulesUsed !== null && caps.customRulesUsed >= caps.customRuleLimit) {
        return { availability: "UNAVAILABLE_PLAN", reason: `All ${caps.customRuleLimit} custom rules of your Cloudflare plan are in use.`, state, managedByTrustifyX };
      }
      break;
    }
  }
  if (!plan.available) return { availability: "UNAVAILABLE_PLAN", reason: plan.reason, state, managedByTrustifyX };
  return { availability: "AVAILABLE", state, managedByTrustifyX };
}

// ─────────────────────────────── preview & apply ───────────────────────────────

export interface PlannedChange {
  key: string;
  label: string;
  applicable: boolean;
  reason?: string;
  caution?: string;
  before: unknown;
  after: unknown;
}

async function liveBefore(client: CloudflareClient, cfZoneId: string, f: ProtectionFeature, config?: ProtectionConfiguration | null): Promise<unknown> {
  switch (f.kind) {
    case "setting":
      return (await client.getSetting(cfZoneId, f.settingId)).value;
    case "bot_fight_mode":
      return { fight_mode: (await client.getBotManagement(cfZoneId)).fight_mode ?? null };
    case "managed_ruleset": {
      const ep = await client.getEntrypoint(cfZoneId, PHASE_MANAGED);
      return { deployed: (ep?.rules ?? []).some((r) => isManagedExecute(r)) };
    }
    case "custom_rule": {
      const ep = await client.getEntrypoint(cfZoneId, PHASE_CUSTOM);
      const existing = config?.cfRuleId ? ep?.rules?.find((r) => r.id === config.cfRuleId) : undefined;
      return { rules: ep?.rules?.length ?? 0, trustifyxRule: existing ? { enabled: existing.enabled !== false } : null };
    }
  }
}

function afterFor(f: ProtectionFeature, mode: "enforce" | "preview"): unknown {
  switch (f.kind) {
    case "setting":
      return f.value;
    case "bot_fight_mode":
      return { fight_mode: true };
    case "managed_ruleset":
      return { deployed: true, enabled: mode === "enforce", rule: { action: "execute", ruleset: MANAGED_RULESET_NAME, expression: "true" } };
    case "custom_rule":
      return { rule: { description: ruleDescription(f), action: f.action, expression: f.expression, enabled: mode === "enforce" } };
  }
}

/**
 * Shows exactly what would change, read live from Cloudflare. The fingerprint must be sent back
 * with the confirmation so a change is only applied if Cloudflare still looks the same.
 */
export async function previewChanges(actor: Actor, zoneRefId: string, keys: string[], mode: "enforce" | "preview" = "enforce") {
  assertCan(actor, "protection.manage");
  await requireProtect(actor.orgId);
  const zone = await loadZone(actor.orgId, zoneRefId);
  await syncZone(zone.id);
  const fresh = await loadZone(actor.orgId, zoneRefId);
  const client = clientFor(fresh.connection);
  const configs = await prisma.protectionConfiguration.findMany({ where: { zoneRefId } });
  const changes: PlannedChange[] = [];
  for (const key of [...new Set(keys)]) {
    const f = featureByKey(key);
    if (!f) throw new ApiError(400, `Unknown protection feature: ${key}`, "invalid_feature");
    const config = configs.find((c) => c.feature === key);
    const st = featureStatus(f, fresh, config);
    let before: unknown = null;
    try {
      before = await liveBefore(client, fresh.cfZoneId, f, config);
    } catch (err) {
      changes.push({ key, label: f.label, applicable: false, reason: (await cfFailure(err, fresh.connectionId, f.permission)).message, before: null, after: null });
      continue;
    }
    let applicable = st.availability === "AVAILABLE";
    let reason = st.reason;
    if (applicable && (st.state === "ENABLED" || st.state === "ENABLED_OUTSIDE_TRUSTIFYX")) {
      applicable = false;
      reason = st.state === "ENABLED" ? "Already enabled by TrustifyX." : "Already enabled in your Cloudflare account. TrustifyX will not take it over.";
    }
    if (applicable && st.state === "PREVIEW") {
      applicable = false;
      reason = "A preview rule already exists. Use Enforce to activate it.";
    }
    if (applicable && mode === "preview" && (f.kind === "setting" || f.kind === "bot_fight_mode")) {
      applicable = false;
      reason = "Settings cannot be previewed in a non-blocking mode; apply them directly.";
    }
    changes.push({ key, label: f.label, applicable, reason, caution: f.caution, before, after: applicable ? afterFor(f, mode) : null });
  }
  const fingerprint = sha256(JSON.stringify({ zone: fresh.cfZoneId, mode, changes: changes.map((c) => [c.key, c.applicable, c.before]) }));
  return { zone: { id: fresh.id, name: fresh.name, website: fresh.website.hostname }, mode, changes, fingerprint };
}

export interface ApplyResult {
  key: string;
  label: string;
  result: "SUCCEEDED" | "FAILED" | "VERIFY_FAILED" | "SKIPPED";
  message: string;
}

/** Applies a previously previewed set of changes after explicit confirmation, verifying each by reading it back. */
export async function applyChanges(actor: Actor, zoneRefId: string, input: { keys: string[]; mode: "enforce" | "preview"; fingerprint: string; confirm: true }) {
  if (input.confirm !== true) throw new ApiError(400, "Explicit confirmation is required", "confirmation_required");
  const preview = await previewChanges(actor, zoneRefId, input.keys, input.mode);
  if (preview.fingerprint !== input.fingerprint) {
    throw new ApiError(409, "Your Cloudflare configuration changed since you reviewed it. Review the changes again.", "preview_stale");
  }
  const zone = await loadZone(actor.orgId, zoneRefId);
  const client = clientFor(zone.connection);
  const results: ApplyResult[] = [];
  for (const change of preview.changes) {
    const f = featureByKey(change.key)!;
    if (!change.applicable) {
      results.push({ key: f.key, label: f.label, result: "SKIPPED", message: change.reason ?? "Not applicable" });
      continue;
    }
    results.push(await applyOne(actor, zone, client, f, input.mode, change.before));
  }
  await syncZone(zone.id).catch(() => undefined);
  return { results };
}

async function applyOne(
  actor: Actor,
  zone: CloudflareZone,
  client: CloudflareClient,
  f: ProtectionFeature,
  mode: "enforce" | "preview",
  before: unknown,
): Promise<ApplyResult> {
  const action = mode === "preview" ? "PREVIEW" : "APPLY";
  const record = async (
    status: string,
    result: Exclude<ApplyResult["result"], "SKIPPED">,
    data: { cfRulesetId?: string | null; cfRuleId?: string | null; observed?: unknown; desired?: unknown; previous?: unknown },
    message: string,
    error?: string,
  ) => {
    const { observed, desired, previous, ...rest } = data;
    await prisma.protectionConfiguration.upsert({
      where: { zoneRefId_feature: { zoneRefId: zone.id, feature: f.key } },
      create: {
        orgId: zone.orgId,
        zoneRefId: zone.id,
        feature: f.key,
        status,
        ...(rest as object),
        observed: observed === undefined ? undefined : json(observed),
        desired: desired === undefined ? undefined : json(desired),
        previous: previous === undefined ? undefined : json(previous),
        verifiedAt: result === "SUCCEEDED" ? new Date() : null,
        lastError: error ?? null,
        updatedById: actor.userId,
      },
      update: {
        status,
        ...(rest as object),
        observed: observed === undefined ? undefined : json(observed),
        desired: desired === undefined ? undefined : json(desired),
        ...(previous === undefined ? {} : { previous: json(previous) }),
        verifiedAt: result === "SUCCEEDED" ? new Date() : undefined,
        lastError: error ?? null,
        updatedById: actor.userId,
      },
    });
    await changeAudit({ orgId: zone.orgId, zoneRefId: zone.id, feature: f.key, action, result, before, after: observed, error, userId: actor.userId, ip: actor.ip });
    await audit({ orgId: zone.orgId, userId: actor.userId, ip: actor.ip, action: `protection.${action.toLowerCase()}`, targetType: "cloudflare_zone", targetId: zone.id, metadata: { feature: f.key, result } });
    return { key: f.key, label: f.label, result, message };
  };

  try {
    switch (f.kind) {
      case "setting": {
        await client.patchSetting(zone.cfZoneId, f.settingId, f.value);
        const readBack = (await client.getSetting(zone.cfZoneId, f.settingId)).value;
        if (!f.satisfied(readBack)) return record("FAILED", "VERIFY_FAILED", { observed: readBack, desired: f.value }, "Cloudflare did not report the new value.", `Read back ${JSON.stringify(readBack)}`);
        return record("ACTIVE", "SUCCEEDED", { observed: readBack, desired: f.value, previous: before }, `Verified: ${f.settingId} is now ${String(readBack)}.`);
      }
      case "bot_fight_mode": {
        const current = await client.getBotManagement(zone.cfZoneId);
        await client.putBotManagement(zone.cfZoneId, { ...pickWritableBot(current), fight_mode: true });
        const readBack = await client.getBotManagement(zone.cfZoneId);
        if (readBack.fight_mode !== true) return record("FAILED", "VERIFY_FAILED", { observed: { fight_mode: readBack.fight_mode ?? null }, desired: { fight_mode: true } }, "Cloudflare did not report Bot Fight Mode as on.", "Read back fight_mode != true");
        return record("ACTIVE", "SUCCEEDED", { observed: { fight_mode: true }, desired: { fight_mode: true }, previous: before }, "Verified: Bot Fight Mode is on.");
      }
      case "managed_ruleset":
      case "custom_rule": {
        const phase = f.kind === "managed_ruleset" ? PHASE_MANAGED : PHASE_CUSTOM;
        const description = ruleDescription(f);
        const rule: CfRule =
          f.kind === "managed_ruleset"
            ? { action: "execute", action_parameters: { id: MANAGED_RULESET_ID }, expression: "true", description, enabled: mode === "enforce" }
            : { action: f.action, expression: f.expression, description, enabled: mode === "enforce" };
        const ep = await client.getEntrypoint(zone.cfZoneId, phase);
        const ruleset = ep ? await client.addRule(zone.cfZoneId, ep.id, rule) : await client.createEntrypoint(zone.cfZoneId, phase, [rule]);
        // Our rule is the newest one with our description (descriptions are unique per feature).
        const created = [...(ruleset.rules ?? [])].reverse().find((r) => r.description === description);
        const readBack = await client.getEntrypoint(zone.cfZoneId, phase);
        const verified = created?.id ? readBack?.rules?.find((r) => r.id === created.id) : undefined;
        if (!verified || (verified.enabled !== false) !== (mode === "enforce")) {
          return record("FAILED", "VERIFY_FAILED", { cfRulesetId: ruleset.id, cfRuleId: created?.id ?? null, observed: verified ?? null, desired: rule }, "The rule could not be verified in Cloudflare.", "Rule not found on read-back");
        }
        return record(
          mode === "enforce" ? "ACTIVE" : "PREVIEW",
          "SUCCEEDED",
          { cfRulesetId: readBack!.id, cfRuleId: verified.id!, observed: { id: verified.id, enabled: verified.enabled !== false, action: verified.action }, desired: rule },
          mode === "enforce" ? "Verified: rule is active in Cloudflare." : "Verified: rule created in Cloudflare but not enforcing (preview).",
        );
      }
    }
  } catch (err) {
    const failure = await cfFailure(err, zone.connectionId, f.permission);
    return record("FAILED", "FAILED", {}, failure.message, failure.message);
  }
}

/** Bot management fields Cloudflare reports but does not accept on update. */
function pickWritableBot(current: Record<string, unknown>) {
  const { using_latest_model: _a, stale_zone_configuration: _b, ...rest } = current;
  void _a;
  void _b;
  return rest;
}

/** Turns a TrustifyX preview rule into an enforcing rule (PATCH with all fields, as Cloudflare requires). */
export async function enforceFeature(actor: Actor, zoneRefId: string, key: string) {
  assertCan(actor, "protection.manage");
  await requireProtect(actor.orgId);
  const zone = await loadZone(actor.orgId, zoneRefId);
  const f = featureByKey(key);
  const config = await prisma.protectionConfiguration.findUnique({ where: { zoneRefId_feature: { zoneRefId, feature: key } } });
  if (!f || (f.kind !== "custom_rule" && f.kind !== "managed_ruleset") || config?.status !== "PREVIEW" || !config.cfRuleId || !config.cfRulesetId) {
    throw new ApiError(400, "There is no preview rule to enforce for this feature.", "not_in_preview");
  }
  const client = clientFor(zone.connection);
  const desired = config.desired as unknown as CfRule;
  try {
    await client.updateRule(zone.cfZoneId, config.cfRulesetId, config.cfRuleId, { ...desired, enabled: true });
    const readBack = await client.getEntrypoint(zone.cfZoneId, f.kind === "managed_ruleset" ? PHASE_MANAGED : PHASE_CUSTOM);
    const rule = readBack?.rules?.find((r) => r.id === config.cfRuleId);
    const ok = Boolean(rule && rule.enabled !== false);
    await prisma.protectionConfiguration.update({
      where: { id: config.id },
      data: ok ? { status: "ACTIVE", verifiedAt: new Date(), observed: json({ id: rule!.id, enabled: true }), lastError: null, updatedById: actor.userId } : { lastError: "Rule not enabled on read-back" },
    });
    await changeAudit({ orgId: actor.orgId, zoneRefId, feature: key, action: "ENFORCE", result: ok ? "SUCCEEDED" : "VERIFY_FAILED", before: { enabled: false }, after: { enabled: ok }, userId: actor.userId, ip: actor.ip });
    if (!ok) throw new ApiError(502, "Cloudflare did not report the rule as enabled.", "verify_failed");
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const failure = await cfFailure(err, zone.connectionId, f.permission);
    await changeAudit({ orgId: actor.orgId, zoneRefId, feature: key, action: "ENFORCE", result: "FAILED", error: failure.message, userId: actor.userId, ip: actor.ip });
    throw failure;
  }
}

/**
 * Reverts a TrustifyX-managed feature: deletes only the rule TrustifyX created, or restores the
 * setting value recorded before TrustifyX changed it. Customer-created rules are never touched.
 */
export async function revertFeature(actor: Actor, zoneRefId: string, key: string) {
  assertCan(actor, "protection.manage");
  const zone = await loadZone(actor.orgId, zoneRefId);
  return revertOne(actor, zone, key);
}

async function revertOne(actor: Actor, zone: CloudflareZone & { connection: CloudflareConnection }, key: string) {
  const f = featureByKey(key);
  const config = await prisma.protectionConfiguration.findUnique({ where: { zoneRefId_feature: { zoneRefId: zone.id, feature: key } } });
  if (!f || !config || (config.status !== "ACTIVE" && config.status !== "PREVIEW")) {
    throw new ApiError(400, "This feature is not managed by TrustifyX on this zone.", "not_managed");
  }
  const client = clientFor(zone.connection);
  try {
    if (f.kind === "setting") {
      if (config.previous === null || config.previous === undefined) throw new ApiError(400, "The previous value is unknown; change it in Cloudflare if needed.", "no_previous");
      await client.patchSetting(zone.cfZoneId, f.settingId, config.previous);
    } else if (f.kind === "bot_fight_mode") {
      const prev = (config.previous as { fight_mode?: boolean } | null)?.fight_mode ?? false;
      const current = await client.getBotManagement(zone.cfZoneId);
      await client.putBotManagement(zone.cfZoneId, { ...pickWritableBot(current), fight_mode: prev });
    } else if (config.cfRuleId && config.cfRulesetId) {
      try {
        await client.deleteRule(zone.cfZoneId, config.cfRulesetId, config.cfRuleId);
      } catch (err) {
        if (!(err instanceof CloudflareApiError && err.status === 404)) throw err; // already gone
      }
    }
    await prisma.protectionConfiguration.update({ where: { id: config.id }, data: { status: "DISABLED", lastError: null, updatedById: actor.userId } });
    await changeAudit({ orgId: zone.orgId, zoneRefId: zone.id, feature: key, action: "REVERT", result: "SUCCEEDED", before: config.observed, after: f.kind === "setting" ? config.previous : null, userId: actor.userId, ip: actor.ip });
    await audit({ orgId: zone.orgId, userId: actor.userId, ip: actor.ip, action: "protection.revert", targetType: "cloudflare_zone", targetId: zone.id, metadata: { feature: key } });
    return { ok: true };
  } catch (err) {
    const failure = err instanceof ApiError ? err : await cfFailure(err, zone.connectionId, f.permission);
    await changeAudit({ orgId: zone.orgId, zoneRefId: zone.id, feature: key, action: "REVERT", result: "FAILED", error: failure.message, userId: actor.userId, ip: actor.ip });
    throw failure;
  }
}

async function revertAllForZone(actor: Actor, zone: CloudflareZone & { connection: CloudflareConnection }) {
  const configs = await prisma.protectionConfiguration.findMany({ where: { zoneRefId: zone.id, status: { in: ["ACTIVE", "PREVIEW"] } } });
  const failures: string[] = [];
  for (const c of configs) {
    try {
      await revertOne(actor, zone, c.feature);
    } catch (err) {
      failures.push(`${c.feature}: ${(err as Error).message}`);
    }
  }
  return failures;
}

export async function unlinkZone(actor: Actor, zoneRefId: string, opts: { removeTrustifyxChanges: boolean }) {
  assertCan(actor, "protection.manage");
  const zone = await loadZone(actor.orgId, zoneRefId);
  const failures = opts.removeTrustifyxChanges ? await revertAllForZone(actor, zone) : [];
  await prisma.cloudflareZone.delete({ where: { id: zone.id } });
  await changeAudit({ orgId: actor.orgId, feature: "zone", action: "ZONE_UNLINK", result: failures.length ? "FAILED" : "SUCCEEDED", before: { zone: zone.name }, error: failures.join("; ") || undefined, userId: actor.userId, ip: actor.ip });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "cloudflare.zone_unlinked", metadata: { zone: zone.name, reverted: opts.removeTrustifyxChanges } });
  return { ok: true, failures };
}

/**
 * Disconnects Cloudflare: optionally removes TrustifyX-made changes first, then deletes the stored
 * token, linked zones and imported events. Customer settings in Cloudflare are otherwise left as they are.
 */
export async function disconnectCloudflare(actor: Actor, opts: { removeTrustifyxChanges: boolean }) {
  assertCan(actor, "protection.manage");
  const conn = await getConnection(actor.orgId);
  const failures: string[] = [];
  if (opts.removeTrustifyxChanges && conn.status === "ACTIVE") {
    const zones = await prisma.cloudflareZone.findMany({ where: { orgId: actor.orgId }, include: { connection: true } });
    for (const z of zones) failures.push(...(await revertAllForZone(actor, z)));
  }
  await prisma.cloudflareConnection.delete({ where: { id: conn.id } });
  await setIntegrationStatus(actor.orgId, "NOT_CONNECTED");
  await changeAudit({ orgId: actor.orgId, feature: "connection", action: "DISCONNECT", result: failures.length ? "FAILED" : "SUCCEEDED", error: failures.join("; ") || undefined, userId: actor.userId, ip: actor.ip });
  await audit({ orgId: actor.orgId, userId: actor.userId, ip: actor.ip, action: "cloudflare.disconnected", metadata: { reverted: opts.removeTrustifyxChanges, failures: failures.length } });
  return { ok: true, failures };
}

/** "Refresh Data": re-reads configuration and imports new security events for one zone (read-only for Cloudflare). */
export async function refreshZone(actor: Actor, zoneRefId: string) {
  assertCan(actor, "protection.read");
  await requireProtect(actor.orgId);
  const zone = await loadZone(actor.orgId, zoneRefId);
  const rl = await rateLimit(`cf:refresh:${zone.id}`, 6, 600);
  if (!rl.allowed) throw new ApiError(429, "This zone was refreshed recently. Please wait a few minutes.", "rate_limited");
  await syncZone(zone.id);
  const events = await syncZoneEvents(zone.id);
  return { ok: true, eventsImported: events.imported, eventsError: events.error };
}

// ─────────────────────────────── overview ───────────────────────────────

export async function protectionOverview(orgId: string) {
  const [access, conn, zones, changes, websites] = await Promise.all([
    protectionAccess(orgId),
    prisma.cloudflareConnection.findUnique({
      where: { orgId },
      select: { status: true, tokenHint: true, tokenExpiresAt: true, lastVerifiedAt: true, lastError: true, createdAt: true },
    }),
    prisma.cloudflareZone.findMany({ where: { orgId }, include: { website: { select: { id: true, hostname: true, displayName: true } }, configs: true }, orderBy: { createdAt: "asc" } }),
    prisma.protectionChangeAudit.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.website.count({ where: { orgId, verifiedAt: { not: null } } }),
  ]);
  return {
    access,
    connection: conn,
    verifiedWebsites: websites,
    zones: zones.map((z) => {
      const obs = z.observed as ZoneObservation | null;
      const caps = z.capabilities as ZoneCapabilities | null;
      return {
        id: z.id,
        name: z.name,
        status: z.status,
        paused: z.paused,
        plan: z.planName ?? z.planCode,
        nameServers: z.nameServers as string[] | null,
        website: z.website,
        lastSyncedAt: z.lastSyncedAt,
        lastSyncError: z.lastSyncError,
        capabilities: caps,
        settings: obs?.settings ?? null,
        dns: obs?.dns ?? null,
        customRules: obs?.customRules ?? null,
        ddos: ddosStatus(z, obs),
        eventCoverage: z.eventCoverage,
        eventsSyncedUntil: z.eventsSyncedUntil,
        eventsError: z.eventsError,
        features: FEATURES.map((f) => {
          const config = z.configs.find((c) => c.feature === f.key);
          return {
            key: f.key,
            label: f.label,
            description: f.description,
            caution: f.caution ?? null,
            kind: f.kind,
            ...featureStatus(f, z, config),
            verifiedAt: config?.verifiedAt ?? null,
            lastError: config?.lastError ?? null,
          };
        }),
      };
    }),
    changes,
  };
}

/** Edge DDoS status from verifiable facts only (Cloudflare's HTTP DDoS protection is always on for proxied traffic). */
export function ddosStatus(zone: Pick<CloudflareZone, "status" | "paused">, obs: ZoneObservation | null) {
  const warnings: string[] = [];
  if (zone.status !== "active") warnings.push(`Zone is "${zone.status}" on Cloudflare: traffic is not protected until activation completes.`);
  if (zone.paused) warnings.push("Cloudflare is paused for this zone: traffic goes directly to your server.");
  if (obs?.dns?.proxied === false) warnings.push("The website's DNS record is not proxied (grey cloud): traffic bypasses Cloudflare.");
  if (obs?.dns?.proxied === null) warnings.push("No DNS record for the website hostname was found in this zone.");
  for (const r of obs?.dns?.exposedRecords ?? []) warnings.push(`${r} is not proxied and points to the same server address, which can reveal your origin.`);
  const protectedAtEdge = zone.status === "active" && !zone.paused && obs?.dns?.proxied === true;
  return {
    edgeProtected: protectedAtEdge,
    summary: protectedAtEdge
      ? "Traffic to this website passes through Cloudflare, where HTTP DDoS protection is always on."
      : obs?.dns === null
        ? "DNS could not be read with this token (DNS Read permission), so proxy status is unknown."
        : "Cloudflare edge protection is not in effect for this website.",
    warnings,
  };
}

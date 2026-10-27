import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { decryptSecret, sha256 } from "../security/crypto";
import { CloudflareApiError, CloudflareClient } from "../integrations/cloudflare/client";

/**
 * Security events from Cloudflare's GraphQL Analytics API (dataset firewallEventsAdaptive).
 * The query only selects fields Cloudflare reports as available for this zone and token
 * (settings.firewallEventsAdaptive.availableFields), and the window respects the reported
 * retention (notOlderThan) and maximum range (maxDuration). Nothing is estimated or invented.
 */

/** Fields we use, mapped to SecurityEvent columns. Only those the account can read are queried. */
const WANTED_FIELDS = [
  "datetime",
  "action",
  "source",
  "rayName",
  "ruleId",
  "clientCountryName",
  "clientRequestHTTPHost",
  "clientRequestPath",
  "clientRequestHTTPMethodName",
  "userAgent",
  "clientIP",
] as const;
type Field = (typeof WANTED_FIELDS)[number];

export interface EventCoverage {
  enabled: boolean;
  /** Seconds back in time Cloudflare lets this account query. */
  notOlderThan: number | null;
  /** Widest single query range in seconds. */
  maxDuration: number | null;
  maxPageSize: number | null;
  fields: string[];
  checkedAt: string;
  requests24h?: number | null;
  requestsAvailable?: boolean;
}

const MAX_PAGES_PER_RUN = 5;
const DEFAULT_LOOKBACK_SEC = 24 * 3600;
/** First import covers the dashboard's default 7-day view (never beyond Cloudflare's retention). */
const INITIAL_LOOKBACK_SEC = 7 * 86400;

const SETTINGS_QUERY = `query Settings($zoneTag: string) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      settings {
        firewallEventsAdaptive { enabled availableFields maxDuration maxPageSize notOlderThan }
        httpRequestsAdaptiveGroups { enabled availableFields maxDuration notOlderThan }
      }
    }
  }
}`;

interface SettingsNode {
  enabled?: boolean;
  availableFields?: string[];
  maxDuration?: number;
  maxPageSize?: number;
  notOlderThan?: number;
}

export async function fetchCoverage(client: CloudflareClient, zoneTag: string): Promise<EventCoverage> {
  const data = await client.graphql<{ viewer?: { zones?: Array<{ settings?: { firewallEventsAdaptive?: SettingsNode; httpRequestsAdaptiveGroups?: SettingsNode } }> } }>(SETTINGS_QUERY, { zoneTag });
  const s = data.viewer?.zones?.[0]?.settings;
  const fe = s?.firewallEventsAdaptive;
  const available = new Set(fe?.availableFields ?? []);
  const fields = WANTED_FIELDS.filter((f) => available.has(f));
  const hr = s?.httpRequestsAdaptiveGroups;
  return {
    enabled: Boolean(fe?.enabled) && fields.includes("datetime") && fields.includes("action"),
    notOlderThan: fe?.notOlderThan ?? null,
    maxDuration: fe?.maxDuration ?? null,
    maxPageSize: fe?.maxPageSize ?? null,
    fields,
    checkedAt: new Date().toISOString(),
    requestsAvailable: Boolean(hr?.enabled) && (hr?.availableFields ?? []).includes("count"),
  };
}

/** Builds the events query from a whitelist of field names (never from user input). */
export function eventsQuery(fields: string[]) {
  const safe = fields.filter((f): f is Field => (WANTED_FIELDS as readonly string[]).includes(f));
  return `query Events($zoneTag: string, $filter: FirewallEventsAdaptiveFilter_InputObject, $limit: uint64) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(filter: $filter, limit: $limit, orderBy: [datetime_ASC]) { ${safe.join(" ")} }
    }
  }
}`;
}

const REQUESTS_QUERY = `query Requests($zoneTag: string, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject) {
  viewer { zones(filter: { zoneTag: $zoneTag }) { httpRequestsAdaptiveGroups(limit: 1, filter: $filter) { count } } }
}`;

type RawEvent = Partial<Record<Field, string | null>>;

/** Stable key: Cloudflare's Ray ID when present (plus rule/action, since one request can match several rules). */
export function eventKey(e: RawEvent): string {
  if (e.rayName) return `ray:${e.rayName}:${e.ruleId ?? ""}:${e.action ?? ""}:${e.source ?? ""}`;
  return `h:${sha256(JSON.stringify(WANTED_FIELDS.map((f) => e[f] ?? null)))}`;
}

export function toRow(orgId: string, zoneRefId: string, e: RawEvent): Prisma.SecurityEventCreateManyInput | null {
  if (!e.datetime || !e.action) return null;
  const at = new Date(e.datetime);
  if (Number.isNaN(at.getTime())) return null;
  const cut = (v: string | null | undefined, n: number) => (v ? String(v).slice(0, n) : null);
  return {
    orgId,
    zoneRefId,
    eventKey: eventKey(e),
    occurredAt: at,
    action: cut(e.action, 40)!,
    source: cut(e.source, 60),
    ruleId: cut(e.ruleId, 100),
    country: cut(e.clientCountryName, 8),
    host: cut(e.clientRequestHTTPHost, 255),
    path: cut(e.clientRequestPath, 512),
    method: cut(e.clientRequestHTTPMethodName, 12),
    userAgent: cut(e.userAgent, 300),
    clientIp: cut(e.clientIP, 64),
    rayId: cut(e.rayName, 40),
  };
}

/**
 * Imports new events for one zone. Resumes from the last imported timestamp, never reads beyond
 * Cloudflare's reported retention, and de-duplicates on (zone, eventKey).
 */
export async function syncZoneEvents(zoneRefId: string, now = new Date()) {
  const zone = await prisma.cloudflareZone.findUniqueOrThrow({ where: { id: zoneRefId }, include: { connection: true } });
  const client = new CloudflareClient(decryptSecret(zone.connection.tokenEnc));
  let coverage: EventCoverage;
  try {
    coverage = await fetchCoverage(client, zone.cfZoneId);
  } catch (err) {
    const msg = err instanceof CloudflareApiError && err.status === 403 ? 'The token needs the "Analytics Read" permission to import security events.' : (err as Error).message;
    await prisma.cloudflareZone.update({ where: { id: zone.id }, data: { eventsError: msg.slice(0, 500) } });
    return { imported: 0, error: msg };
  }
  if (!coverage.enabled) {
    await prisma.cloudflareZone.update({
      where: { id: zone.id },
      data: { eventCoverage: coverage as unknown as Prisma.InputJsonValue, eventsError: "Security event data unavailable for the connected Cloudflare plan or permissions." },
    });
    return { imported: 0, error: "unavailable" };
  }

  const oldest = new Date(now.getTime() - ((coverage.notOlderThan ?? DEFAULT_LOOKBACK_SEC) - 300) * 1000);
  let from = zone.eventsSyncedUntil && zone.eventsSyncedUntil > oldest ? zone.eventsSyncedUntil : new Date(Math.max(oldest.getTime(), now.getTime() - INITIAL_LOOKBACK_SEC * 1000));
  const maxSpanMs = (coverage.maxDuration ?? DEFAULT_LOOKBACK_SEC) * 1000;
  const limit = Math.min(coverage.maxPageSize ?? 1000, 1000);
  const query = eventsQuery(coverage.fields);
  let imported = 0;
  let error: string | null = null;

  for (let page = 0; page < MAX_PAGES_PER_RUN && from < now; page++) {
    const to = new Date(Math.min(now.getTime(), from.getTime() + maxSpanMs));
    let events: RawEvent[];
    try {
      const data = await client.graphql<{ viewer?: { zones?: Array<{ firewallEventsAdaptive?: RawEvent[] }> } }>(query, {
        zoneTag: zone.cfZoneId,
        filter: { datetime_geq: from.toISOString(), datetime_leq: to.toISOString() },
        limit,
      });
      events = data.viewer?.zones?.[0]?.firewallEventsAdaptive ?? [];
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
      break;
    }
    const rows = events.map((e) => toRow(zone.orgId, zone.id, e)).filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) imported += (await prisma.securityEvent.createMany({ data: rows, skipDuplicates: true })).count;
    // A full page means there may be more in this window: continue from the last event's time
    // (the boundary event is de-duplicated by its key). Otherwise the window is complete.
    const last = rows.length ? (rows[rows.length - 1].occurredAt as Date) : null;
    // If a whole page shares one timestamp we cannot page further inside it; move on rather than loop.
    from = events.length >= limit && last && last > from ? last : to;
  }

  if (coverage.requestsAvailable) {
    try {
      const r = await client.graphql<{ viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: Array<{ count?: number }> }> } }>(REQUESTS_QUERY, {
        zoneTag: zone.cfZoneId,
        filter: { datetime_geq: new Date(now.getTime() - 24 * 3600_000).toISOString(), datetime_leq: now.toISOString() },
      });
      coverage.requests24h = r.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups?.[0]?.count ?? null;
    } catch {
      coverage.requests24h = null;
    }
  }

  await prisma.cloudflareZone.update({
    where: { id: zone.id },
    data: { eventCoverage: coverage as unknown as Prisma.InputJsonValue, eventsSyncedUntil: from, eventsError: error },
  });
  return { imported, error };
}

// ─────────────────────────────── reporting ───────────────────────────────

export const BLOCK_ACTIONS = new Set(["block", "drop", "connectionclose", "connection_close"]);
export const CHALLENGE_ACTIONS = new Set(["challenge", "managed_challenge", "managedchallenge", "js_challenge", "jschallenge", "challengesolved", "challenge_solved"]);
export const ALLOW_ACTIONS = new Set(["allow", "skip", "bypass", "log"]);

export function actionGroup(action: string): "blocked" | "challenged" | "allowed" | "other" {
  const a = action.toLowerCase();
  if (BLOCK_ACTIONS.has(a)) return "blocked";
  if (CHALLENGE_ACTIONS.has(a)) return "challenged";
  if (ALLOW_ACTIONS.has(a)) return "allowed";
  return "other";
}

/** Event statistics for one organization (optionally one zone), computed from imported events only. */
export async function eventSummary(orgId: string, opts: { zoneRefId?: string; days?: number } = {}) {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 31);
  const since = new Date(Date.now() - days * 86_400_000);
  const where: Prisma.SecurityEventWhereInput = { orgId, occurredAt: { gte: since }, ...(opts.zoneRefId ? { zoneRefId: opts.zoneRefId } : {}) };
  const [byAction, byCountry, recent, total, zones] = await Promise.all([
    prisma.securityEvent.groupBy({ by: ["action"], where, _count: { _all: true } }),
    prisma.securityEvent.groupBy({ by: ["country"], where: { ...where, country: { not: null } }, _count: { _all: true }, orderBy: { _count: { country: "desc" } }, take: 6 }),
    prisma.securityEvent.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: { id: true, occurredAt: true, action: true, source: true, ruleId: true, country: true, host: true, path: true, method: true, rayId: true, zone: { select: { name: true } } },
    }),
    prisma.securityEvent.count({ where }),
    prisma.cloudflareZone.findMany({
      where: { orgId, ...(opts.zoneRefId ? { id: opts.zoneRefId } : {}) },
      select: { id: true, name: true, eventCoverage: true, eventsSyncedUntil: true, eventsError: true },
    }),
  ]);
  const totals = { blocked: 0, challenged: 0, allowed: 0, other: 0 };
  for (const a of byAction) totals[actionGroup(a.action)] += a._count._all;

  // Daily trend (UTC days), filled with zeros so gaps are visible rather than interpolated.
  const trendRows = await prisma.$queryRaw<Array<{ day: Date; action: string; n: bigint }>>`
    SELECT date_trunc('day', "occurredAt") AS day, action, COUNT(*)::bigint AS n
    FROM "SecurityEvent" WHERE "orgId" = ${orgId} AND "occurredAt" >= ${since} ${opts.zoneRefId ? Prisma.sql`AND "zoneRefId" = ${opts.zoneRefId}` : Prisma.empty}
    GROUP BY 1, 2 ORDER BY 1`;
  const trend: Array<{ day: string; blocked: number; challenged: number; allowed: number; other: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    trend.push({ day: d.toISOString().slice(0, 10), blocked: 0, challenged: 0, allowed: 0, other: 0 });
  }
  for (const r of trendRows) {
    const t = trend.find((x) => x.day === new Date(r.day).toISOString().slice(0, 10));
    if (t) t[actionGroup(r.action)] += Number(r.n);
  }
  return {
    days,
    total,
    totals,
    byAction: byAction.map((a) => ({ action: a.action, count: a._count._all })).sort((a, b) => b.count - a.count),
    topCountries: byCountry.map((c) => ({ country: c.country, count: c._count._all })),
    recent,
    trend,
    zones: zones.map((z) => ({ id: z.id, name: z.name, coverage: z.eventCoverage as EventCoverage | null, syncedUntil: z.eventsSyncedUntil, error: z.eventsError })),
  };
}

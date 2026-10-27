/**
 * TEST FIXTURE — an in-memory imitation of the Cloudflare API v4 endpoints Secure360 uses,
 * shaped after Cloudflare's public documentation. It is NOT a live Cloudflare account and
 * passing tests against it does not prove the live integration works.
 */

export interface FakeRule {
  id: string;
  action: string;
  expression: string;
  description?: string;
  enabled?: boolean;
  action_parameters?: Record<string, unknown>;
}

export interface FakeZone {
  id: string;
  name: string;
  status: string;
  plan: "free" | "pro" | "business" | "enterprise";
  paused?: boolean;
  settings: Record<string, unknown>;
  dns: Array<{ id: string; type: string; name: string; content: string; proxied: boolean }>;
  rulesets: Record<string, { id: string; rules: FakeRule[] }>; // by phase
  bot: Record<string, unknown>;
  events: Array<Record<string, string>>;
  requests24h?: number;
}

export interface FakeOptions {
  token: string;
  tokenStatus?: "active" | "disabled" | "expired";
  zones: FakeZone[];
  /** Capabilities the token lacks → HTTP 403 (e.g. "dns", "settings_edit", "waf", "bots", "analytics", "zone"). */
  deny?: string[];
  /** Fields the account may query in firewallEventsAdaptive. */
  availableFields?: string[];
  eventsEnabled?: boolean;
  notOlderThan?: number;
  maxDuration?: number;
  maxPageSize?: number;
  /** Simulate Cloudflare accepting a PATCH but not applying it (to test read-back verification). */
  ignoreSettingWrites?: boolean;
}

export const ALL_EVENT_FIELDS = [
  "datetime", "action", "source", "rayName", "ruleId", "clientCountryName", "clientRequestHTTPHost",
  "clientRequestPath", "clientRequestHTTPMethodName", "userAgent", "clientIP",
];

const MANAGED_ID = "efb7b8c949ac4650a09736fc376e9aee";
let seq = 0;
const nid = () => `${(++seq).toString(16).padStart(8, "0")}${"0".repeat(24)}`.slice(0, 32);

export function zoneId(n: number) {
  return `${n.toString(16).padStart(2, "0")}${"a".repeat(30)}`;
}

export function makeFakeCloudflare(opts: FakeOptions) {
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const graphqlQueries: string[] = [];
  const ok = (result: unknown, status = 200, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result, ...extra }), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number, message: string) =>
    new Response(JSON.stringify({ success: false, errors: [{ code: status * 10, message }], messages: [], result: null }), { status, headers: { "content-type": "application/json" } });
  const denied = (cap: string) => opts.deny?.includes(cap);

  async function handle(url: string, init: RequestInit): Promise<Response> {
    const auth = new Headers(init.headers).get("authorization");
    if (auth !== `Bearer ${opts.token}`) return fail(401, "Invalid API Token");
    const u = new URL(url);
    if (u.origin !== "https://api.cloudflare.com" || !u.pathname.startsWith("/client/v4/")) return fail(404, "not found");
    const path = u.pathname.replace("/client/v4", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET" && path !== "/graphql") writes.push({ method, path, body });

    if (path === "/user/tokens/verify") return ok({ id: "tok123", status: opts.tokenStatus ?? "active" });

    if (path === "/graphql") return graphql(body as { query: string; variables: Record<string, unknown> });

    if (path === "/zones") {
      if (denied("zone")) return fail(403, "Authentication error");
      const name = u.searchParams.get("name");
      const list = opts.zones.filter((z) => !name || z.name === name).map(publicZone);
      return ok(list, 200, { result_info: { page: 1, total_pages: 1 } });
    }
    const m = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    if (!m) return fail(404, "not found");
    const zone = opts.zones.find((z) => z.id === m[1]);
    if (!zone) return fail(404, "Zone not found");
    const rest = m[2] ?? "";

    if (rest === "") return ok(publicZone(zone));
    if (rest === "/dns_records") {
      if (denied("dns")) return fail(403, "Authentication error");
      const name = u.searchParams.get("name");
      return ok(zone.dns.filter((r) => !name || r.name === name));
    }
    const setting = rest.match(/^\/settings\/([a-z_0-9]+)$/);
    if (setting) {
      if (denied("settings")) return fail(403, "Authentication error");
      if (method === "PATCH") {
        if (denied("settings_edit")) return fail(403, "Authentication error");
        if (!opts.ignoreSettingWrites) zone.settings[setting[1]] = (body as { value: unknown }).value;
      }
      return ok({ id: setting[1], value: zone.settings[setting[1]] ?? "off", editable: true });
    }
    if (rest === "/bot_management") {
      if (denied("bots")) return fail(403, "Authentication error");
      if (method === "PUT") {
        if (denied("bots_edit")) return fail(403, "Authentication error");
        zone.bot = { ...zone.bot, ...(body as object) };
      }
      return ok({ ...zone.bot, using_latest_model: true });
    }
    if (rest === "/rulesets") {
      if (denied("waf")) return fail(403, "Authentication error");
      if (method === "POST") {
        const b = body as { phase: string; rules: FakeRule[] };
        if (zone.rulesets[b.phase]) return fail(400, "entry point already exists");
        const rs = { id: nid(), rules: b.rules.map((r) => ({ ...r, id: nid() })) };
        zone.rulesets[b.phase] = rs;
        return ok({ ...rs, phase: b.phase, kind: "zone" });
      }
      const managed = zone.plan === "free" ? [] : [{ id: MANAGED_ID, name: "Cloudflare Managed Ruleset", kind: "managed", phase: "http_request_firewall_managed" }];
      return ok([...managed, ...Object.entries(zone.rulesets).map(([phase, rs]) => ({ id: rs.id, kind: "zone", phase }))]);
    }
    const entry = rest.match(/^\/rulesets\/phases\/([a-z_]+)\/entrypoint$/);
    if (entry) {
      if (denied("waf")) return fail(403, "Authentication error");
      const rs = zone.rulesets[entry[1]];
      return rs ? ok({ ...rs, phase: entry[1], kind: "zone" }) : fail(404, "Could not find entrypoint ruleset");
    }
    const rules = rest.match(/^\/rulesets\/([a-f0-9]+)\/rules(?:\/([a-f0-9]+))?$/);
    if (rules) {
      if (denied("waf") || denied("waf_edit")) return fail(403, "Authentication error");
      const phase = Object.keys(zone.rulesets).find((p) => zone.rulesets[p].id === rules[1]);
      if (!phase) return fail(404, "ruleset not found");
      const rs = zone.rulesets[phase];
      if (method === "POST") {
        const r = body as FakeRule;
        if (phase === "http_request_firewall_custom") {
          const limit = { free: 5, pro: 20, business: 100, enterprise: 1000 }[zone.plan];
          if (rs.rules.length >= limit) return fail(400, "exceeded maximum number of rules");
          if (r.action === "log" && zone.plan !== "enterprise") return fail(400, "log action not allowed");
        }
        if (r.action === "execute" && zone.plan === "free") return fail(403, "not entitled to managed ruleset");
        rs.rules.push({ ...r, id: nid() });
      } else if (method === "PATCH" && rules[2]) {
        const idx = rs.rules.findIndex((x) => x.id === rules[2]);
        if (idx < 0) return fail(404, "rule not found");
        rs.rules[idx] = { ...(body as FakeRule), id: rules[2] };
      } else if (method === "DELETE" && rules[2]) {
        const idx = rs.rules.findIndex((x) => x.id === rules[2]);
        if (idx < 0) return fail(404, "rule not found");
        rs.rules.splice(idx, 1);
      }
      return ok({ ...rs, phase, kind: "zone" });
    }
    return fail(404, "not found");
  }

  function publicZone(z: FakeZone) {
    return { id: z.id, name: z.name, status: z.status, paused: Boolean(z.paused), name_servers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], plan: { name: `${z.plan[0].toUpperCase()}${z.plan.slice(1)} Website`, legacy_id: z.plan } };
  }

  function graphql({ query, variables }: { query: string; variables: Record<string, unknown> }): Response {
    graphqlQueries.push(query);
    const gql = (data: unknown, errors: unknown[] | null = null) => new Response(JSON.stringify({ data, errors }), { status: 200, headers: { "content-type": "application/json" } });
    if (denied("analytics")) return gql(null, [{ message: "not authorized for that account" }]);
    const zone = opts.zones.find((z) => z.id === variables.zoneTag);
    if (!zone) return gql(null, [{ message: "zone not found" }]);
    const available = opts.availableFields ?? ALL_EVENT_FIELDS;
    if (query.includes("settings")) {
      return gql({
        viewer: {
          zones: [{
            settings: {
              firewallEventsAdaptive: { enabled: opts.eventsEnabled ?? true, availableFields: available, maxDuration: opts.maxDuration ?? 259200, maxPageSize: opts.maxPageSize ?? 10000, notOlderThan: opts.notOlderThan ?? 2678400 },
              httpRequestsAdaptiveGroups: { enabled: zone.requests24h !== undefined, availableFields: ["count"], maxDuration: 259200, notOlderThan: 2678400 },
            },
          }],
        },
      });
    }
    if (query.includes("firewallEventsAdaptive(")) {
      const fieldList = query.match(/orderBy: \[datetime_ASC\]\) \{ ([^}]*) \}/)?.[1].trim().split(/\s+/) ?? [];
      const unknown = fieldList.filter((f) => !available.includes(f));
      if (unknown.length) return gql(null, [{ message: `unknown field "${unknown[0]}"` }]);
      const filter = variables.filter as { datetime_geq: string; datetime_leq: string };
      const rows = zone.events
        .filter((e) => e.datetime >= filter.datetime_geq && e.datetime <= filter.datetime_leq)
        .sort((a, b) => a.datetime.localeCompare(b.datetime))
        .slice(0, Number(variables.limit))
        .map((e) => Object.fromEntries(fieldList.map((f) => [f, e[f] ?? null])));
      return gql({ viewer: { zones: [{ firewallEventsAdaptive: rows }] } });
    }
    if (query.includes("httpRequestsAdaptiveGroups(")) {
      return gql({ viewer: { zones: [{ httpRequestsAdaptiveGroups: [{ count: zone.requests24h ?? 0 }] }] } });
    }
    return gql(null, [{ message: "unsupported query in fake" }]);
  }

  return { fetch: handle, writes, graphqlQueries, opts };
}

export function baseZone(over: Partial<FakeZone> & Pick<FakeZone, "id" | "name">): FakeZone {
  return {
    status: "active",
    plan: "free",
    settings: { always_use_https: "off", min_tls_version: "1.0", ssl: "full", security_level: "medium" },
    dns: [],
    rulesets: {},
    bot: { fight_mode: false, enable_js: false },
    events: [],
    ...over,
  };
}

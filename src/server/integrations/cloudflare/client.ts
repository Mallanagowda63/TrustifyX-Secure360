import { env } from "../../env";

/**
 * Minimal client for the official Cloudflare API v4 (https://developers.cloudflare.com/api/).
 * Only the endpoints Secure360 needs. The base URL is fixed to api.cloudflare.com in production,
 * so customer input can never redirect requests elsewhere (no SSRF surface).
 */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchOverride: FetchLike | null = null;

/** Tests inject a fake Cloudflare API here (clearly labelled fixtures, never a live account). */
export function setCloudflareFetch(f: FetchLike | null) {
  fetchOverride = f;
}

export class CloudflareApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: Array<{ code?: number; message?: string }> = [],
  ) {
    super(message);
  }
  /** Missing token permission or plan entitlement. */
  get forbidden() {
    return this.status === 403;
  }
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  paused?: boolean;
  name_servers?: string[];
  plan?: { id?: string; name?: string; legacy_id?: string };
  account?: { id?: string; name?: string };
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  proxiable?: boolean;
}

export interface CfRule {
  id?: string;
  action: string;
  expression: string;
  description?: string;
  enabled?: boolean;
  ref?: string;
  action_parameters?: Record<string, unknown>;
}

export interface CfRuleset {
  id: string;
  name?: string;
  kind?: string;
  phase?: string;
  description?: string;
  rules?: CfRule[];
}

const TIMEOUT_MS = 15_000;

function baseUrl() {
  const e = env();
  const configured = (e.CLOUDFLARE_API_BASE ?? "").replace(/\/$/, "");
  if (configured && e.NODE_ENV !== "production") return configured;
  return CLOUDFLARE_API_BASE;
}

export class CloudflareClient {
  constructor(private token: string) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new CloudflareApiError(400, "That does not look like a Cloudflare API token");
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ result: T; resultInfo?: Record<string, unknown> }> {
    const url = new URL(`${baseUrl()}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const f = fetchOverride ?? ((u: string, init: RequestInit) => fetch(u, init));
    let res: Response;
    try {
      res = await f(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      throw new CloudflareApiError(502, `Could not reach the Cloudflare API: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      result_info?: Record<string, unknown>;
      errors?: Array<{ code?: number; message?: string }>;
      data?: T;
    };
    if (!res.ok || data.success === false) {
      const msg = data.errors?.map((e) => e.message).filter(Boolean).join("; ") || `Cloudflare API error (HTTP ${res.status})`;
      throw new CloudflareApiError(res.status, msg, data.errors ?? []);
    }
    return { result: data.result as T, resultInfo: data.result_info };
  }

  // ─── Token & zones ───
  verifyToken() {
    return this.request<{ id: string; status: string; expires_on?: string; not_before?: string }>("GET", "/user/tokens/verify").then((r) => r.result);
  }

  async listZones(name?: string): Promise<CfZone[]> {
    const out: CfZone[] = [];
    for (let page = 1; page <= 10; page++) {
      const { result, resultInfo } = await this.request<CfZone[]>("GET", "/zones", undefined, { per_page: "50", page: String(page), ...(name ? { name } : {}) });
      out.push(...(result ?? []));
      const totalPages = Number(resultInfo?.total_pages ?? 1);
      if (page >= totalPages) break;
    }
    return out;
  }

  getZone(zoneId: string) {
    return this.request<CfZone>("GET", `/zones/${enc(zoneId)}`).then((r) => r.result);
  }

  listDnsRecords(zoneId: string, name?: string) {
    return this.request<CfDnsRecord[]>("GET", `/zones/${enc(zoneId)}/dns_records`, undefined, { per_page: "100", ...(name ? { name } : {}) }).then((r) => r.result ?? []);
  }

  // ─── Zone settings ───
  getSetting(zoneId: string, id: string) {
    return this.request<{ id: string; value: unknown; editable?: boolean }>("GET", `/zones/${enc(zoneId)}/settings/${enc(id)}`).then((r) => r.result);
  }

  patchSetting(zoneId: string, id: string, value: unknown) {
    return this.request<{ id: string; value: unknown }>("PATCH", `/zones/${enc(zoneId)}/settings/${enc(id)}`, { value }).then((r) => r.result);
  }

  // ─── Rulesets (WAF custom + managed rules) ───
  listRulesets(zoneId: string) {
    return this.request<CfRuleset[]>("GET", `/zones/${enc(zoneId)}/rulesets`).then((r) => r.result ?? []);
  }

  /** Entry point ruleset of a phase, or null when it does not exist yet (HTTP 404). */
  async getEntrypoint(zoneId: string, phase: string): Promise<CfRuleset | null> {
    try {
      return (await this.request<CfRuleset>("GET", `/zones/${enc(zoneId)}/rulesets/phases/${enc(phase)}/entrypoint`)).result;
    } catch (err) {
      if (err instanceof CloudflareApiError && err.status === 404) return null;
      throw err;
    }
  }

  createEntrypoint(zoneId: string, phase: string, rules: CfRule[]) {
    return this.request<CfRuleset>("POST", `/zones/${enc(zoneId)}/rulesets`, {
      name: `default ${phase}`,
      description: "Created by TrustifyX Secure360",
      kind: "zone",
      phase,
      rules,
    }).then((r) => r.result);
  }

  /** Adds one rule at the end of an existing ruleset; other rules are untouched. */
  addRule(zoneId: string, rulesetId: string, rule: CfRule) {
    return this.request<CfRuleset>("POST", `/zones/${enc(zoneId)}/rulesets/${enc(rulesetId)}/rules`, rule).then((r) => r.result);
  }

  /** PATCH replaces the rule's fields: callers must send every field they want to keep. */
  updateRule(zoneId: string, rulesetId: string, ruleId: string, rule: CfRule) {
    return this.request<CfRuleset>("PATCH", `/zones/${enc(zoneId)}/rulesets/${enc(rulesetId)}/rules/${enc(ruleId)}`, rule).then((r) => r.result);
  }

  deleteRule(zoneId: string, rulesetId: string, ruleId: string) {
    return this.request<CfRuleset>("DELETE", `/zones/${enc(zoneId)}/rulesets/${enc(rulesetId)}/rules/${enc(ruleId)}`).then((r) => r.result);
  }

  // ─── Bots ───
  getBotManagement(zoneId: string) {
    return this.request<Record<string, unknown>>("GET", `/zones/${enc(zoneId)}/bot_management`).then((r) => r.result);
  }

  putBotManagement(zoneId: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("PUT", `/zones/${enc(zoneId)}/bot_management`, body).then((r) => r.result);
  }

  // ─── GraphQL Analytics API ───
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const f = fetchOverride ?? ((u: string, init: RequestInit) => fetch(u, init));
    let res: Response;
    try {
      res = await f(`${baseUrl()}/graphql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      throw new CloudflareApiError(502, `Could not reach the Cloudflare API: ${(err as Error).message}`);
    }
    const data = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string }> | null };
    if (!res.ok || (data.errors && data.errors.length)) {
      throw new CloudflareApiError(res.ok ? 400 : res.status, data.errors?.map((e) => e.message).join("; ") || `Cloudflare GraphQL error (HTTP ${res.status})`);
    }
    return data.data as T;
  }
}

const enc = (s: string) => {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(s)) throw new CloudflareApiError(400, "Invalid identifier");
  return encodeURIComponent(s);
};

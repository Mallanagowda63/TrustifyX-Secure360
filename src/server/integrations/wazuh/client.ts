import https from "node:https";
import { readFileSync } from "node:fs";
import { env } from "../../env";

/**
 * Client for the TrustifyX-operated Wazuh manager API (port 55000) and Wazuh indexer (9200).
 * Both must sit on a private network; TLS is always verified (WAZUH_CA_FILE for the self-signed
 * Wazuh CA). Requests only ever go to the configured URLs, never to customer-supplied hosts.
 * Docs: https://documentation.wazuh.com/current/user-manual/api/getting-started.html
 */

export class WazuhError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WazuhRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export type WazuhTransport = (req: WazuhRequest) => Promise<{ status: number; body: string }>;

let transportOverride: WazuhTransport | null = null;
/** Tests inject a fake Wazuh manager/indexer here (labelled fixtures, never a live server). */
export function setWazuhTransport(t: WazuhTransport | null) {
  transportOverride = t;
  token = null;
}

export function wazuhConfigured(): boolean {
  const e = env();
  return Boolean(e.WAZUH_API_URL && e.WAZUH_API_USER && e.WAZUH_API_PASSWORD && e.WAZUH_MANAGER_ADDRESS);
}

export function wazuhEventsConfigured(): boolean {
  const e = env();
  return Boolean(e.WAZUH_INDEXER_URL && e.WAZUH_INDEXER_USER && e.WAZUH_INDEXER_PASSWORD);
}

let ca: Buffer | undefined;
const nodeTransport: WazuhTransport = (req) =>
  new Promise((resolve, reject) => {
    const file = env().WAZUH_CA_FILE;
    if (file && !ca) ca = readFileSync(file);
    const u = new URL(req.url);
    const r = https.request(
      { method: req.method, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: req.headers, ca, rejectUnauthorized: true, timeout: 15_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > 5_000_000) r.destroy(new Error("Response too large"));
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("timeout", () => r.destroy(new Error("Wazuh request timed out")));
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });

async function send(req: WazuhRequest) {
  try {
    return await (transportOverride ?? nodeTransport)(req);
  } catch (err) {
    throw new WazuhError(502, `Could not reach the Wazuh server: ${(err as Error).message}`);
  }
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

let token: { value: string; expires: number } | null = null;

async function apiToken(): Promise<string> {
  if (token && token.expires > Date.now()) return token.value;
  const e = env();
  const res = await send({ method: "POST", url: `${e.WAZUH_API_URL}/security/user/authenticate?raw=true`, headers: { Authorization: basic(e.WAZUH_API_USER!, e.WAZUH_API_PASSWORD!) } });
  if (res.status !== 200 || !res.body.trim()) throw new WazuhError(res.status || 502, "Wazuh API authentication failed");
  // Tokens are short-lived (sample lifetimes are 15 minutes); refresh well before.
  token = { value: res.body.trim(), expires: Date.now() + 10 * 60_000 };
  return token.value;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const call = async () =>
    send({
      method,
      url: `${env().WAZUH_API_URL}${path}`,
      headers: { Authorization: `Bearer ${await apiToken()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res = await call();
  if (res.status === 401) {
    token = null;
    res = await call();
  }
  let data: { error?: number; data?: T; detail?: string; title?: string };
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new WazuhError(502, `Unexpected Wazuh API response (HTTP ${res.status})`);
  }
  if (res.status >= 400 || (data.error && data.error !== 0)) throw new WazuhError(res.status, data.detail ?? data.title ?? `Wazuh API error (HTTP ${res.status})`);
  return data.data as T;
}

export interface WazuhAgentInfo {
  id: string;
  name?: string;
  status?: string;
  lastKeepAlive?: string;
  version?: string;
  os?: { name?: string; platform?: string; version?: string };
}

/** Pre-registers an agent; returns its ID and the client key the server imports with manage_agents -i. */
export async function addAgent(name: string): Promise<{ id: string; key: string }> {
  const d = await api<{ id?: string; key?: string }>("POST", "/agents", { name });
  if (!d?.id || !d.key) throw new WazuhError(502, "Wazuh did not return an agent ID and key");
  return { id: String(d.id), key: d.key };
}

export async function getAgents(ids: string[]): Promise<WazuhAgentInfo[]> {
  if (!ids.length) return [];
  const safe = ids.filter((i) => /^\d{3,6}$/.test(i));
  const d = await api<{ affected_items?: WazuhAgentInfo[] }>("GET", `/agents?agents_list=${safe.join(",")}&select=id,name,status,lastKeepAlive,version,os.name,os.platform,os.version`);
  return d?.affected_items ?? [];
}

export async function deleteAgent(id: string) {
  if (!/^\d{3,6}$/.test(id)) throw new WazuhError(400, "Invalid agent id");
  await api("DELETE", `/agents?agents_list=${id}&status=all&older_than=0s`);
}

export interface WazuhAlert {
  id?: string;
  timestamp?: string;
  rule?: { id?: string; level?: number; description?: string; groups?: string[] };
  agent?: { id?: string; name?: string };
  syscheck?: { path?: string; event?: string };
  full_log?: string;
  location?: string;
}

/** Alerts for exactly these agent IDs, newer than `since`, oldest first. */
export async function searchAlerts(agentIds: string[], since: Date, size = 500): Promise<WazuhAlert[]> {
  const e = env();
  const safe = agentIds.filter((i) => /^\d{3,6}$/.test(i));
  if (!safe.length) return [];
  const index = e.WAZUH_ALERTS_INDEX.replace(/[^A-Za-z0-9_*.-]/g, "");
  const res = await send({
    method: "POST",
    url: `${e.WAZUH_INDEXER_URL}/${index}/_search`,
    headers: { Authorization: basic(e.WAZUH_INDEXER_USER!, e.WAZUH_INDEXER_PASSWORD!), "Content-Type": "application/json" },
    body: JSON.stringify({
      size,
      sort: [{ timestamp: { order: "asc" } }],
      query: { bool: { filter: [{ terms: { "agent.id": safe } }, { range: { timestamp: { gt: since.toISOString() } } }] } },
      _source: ["id", "timestamp", "rule.id", "rule.level", "rule.description", "rule.groups", "agent.id", "agent.name", "syscheck.path", "syscheck.event", "full_log", "location"],
    }),
  });
  if (res.status >= 400) throw new WazuhError(res.status, `Wazuh indexer search failed (HTTP ${res.status})`);
  const data = JSON.parse(res.body) as { hits?: { hits?: Array<{ _id?: string; _source?: WazuhAlert }> } };
  return (data.hits?.hits ?? []).map((h) => ({ ...(h._source ?? {}), id: h._source?.id ?? h._id }));
}

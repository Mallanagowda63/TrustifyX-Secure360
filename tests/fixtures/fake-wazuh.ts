/**
 * TEST FIXTURE — in-memory imitation of the Wazuh server API (authenticate, add/list/delete agents)
 * and the Wazuh indexer search endpoint, shaped after the public Wazuh documentation.
 * It is NOT a Wazuh installation; passing tests here do not prove the live integration.
 */
import type { WazuhRequest } from "@/server/integrations/wazuh/client";

export interface FakeAgent {
  id: string;
  name: string;
  key: string;
  status: string;
  lastKeepAlive?: string;
  version?: string;
  os?: { name: string; version: string };
}

export function makeFakeWazuh() {
  let seq = 1;
  const agents = new Map<string, FakeAgent>();
  const alerts: Array<Record<string, unknown>> = [];
  const searches: Array<Record<string, unknown>> = [];
  const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

  async function transport(req: WazuhRequest) {
    const u = new URL(req.url);
    if (u.port === "55000") {
      if (u.pathname === "/security/user/authenticate") {
        return req.headers.Authorization === `Basic ${Buffer.from("wazuh-api:api-secret").toString("base64")}` ? { status: 200, body: "jwt-token-123" } : json(401, { title: "Unauthorized" });
      }
      if (req.headers.Authorization !== "Bearer jwt-token-123") return json(401, { title: "Unauthorized" });
      if (u.pathname === "/agents" && req.method === "POST") {
        const { name } = JSON.parse(req.body ?? "{}");
        const id = String(seq++).padStart(3, "0");
        const key = Buffer.from(`${id} ${name} any ${"k".repeat(16)}`).toString("base64");
        agents.set(id, { id, name, key, status: "never_connected" });
        return json(200, { error: 0, data: { id, key } });
      }
      if (u.pathname === "/agents" && req.method === "GET") {
        const ids = (u.searchParams.get("agents_list") ?? "").split(",");
        return json(200, { error: 0, data: { affected_items: ids.map((i) => agents.get(i)).filter(Boolean), total_affected_items: ids.length } });
      }
      if (u.pathname === "/agents" && req.method === "DELETE") {
        for (const i of (u.searchParams.get("agents_list") ?? "").split(",")) agents.delete(i);
        return json(200, { error: 0, data: { affected_items: [] } });
      }
      return json(404, { title: "Not found" });
    }
    if (u.port === "9200" && u.pathname.endsWith("/_search")) {
      const q = JSON.parse(req.body ?? "{}");
      searches.push(q);
      const ids: string[] = q.query.bool.filter[0].terms["agent.id"];
      const gt: string = q.query.bool.filter[1].range.timestamp.gt;
      const hits = alerts
        .filter((a) => ids.includes(String((a.agent as { id: string }).id)) && String(a.timestamp) > gt)
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        .slice(0, q.size)
        .map((a) => ({ _id: `doc-${a.id}`, _source: a }));
      return json(200, { hits: { hits } });
    }
    return json(404, {});
  }

  return { transport, agents, alerts, searches };
}

export const WAZUH_TEST_ENV = {
  WAZUH_API_URL: "https://wazuh.internal:55000",
  WAZUH_API_USER: "wazuh-api",
  WAZUH_API_PASSWORD: "api-secret",
  WAZUH_INDEXER_URL: "https://wazuh.internal:9200",
  WAZUH_INDEXER_USER: "indexer",
  WAZUH_INDEXER_PASSWORD: "indexer-secret",
  WAZUH_MANAGER_ADDRESS: "agents.secure360.example",
};

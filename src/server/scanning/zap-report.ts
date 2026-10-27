/**
 * Parses ZAP's "traditional JSON" report
 * (https://www.zaproxy.org/docs/desktop/addons/report-generation/report-traditional-json/).
 * The report is untrusted input: fields are type-checked, HTML is stripped, sizes are capped,
 * and alerts for any host other than the scanned one are dropped.
 */

export type Risk = "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type Confidence = "CONFIRMED" | "HIGH" | "MEDIUM" | "LOW" | "FALSE_POSITIVE";

export interface ScanAlert {
  pluginId: string;
  alertRef: string | null;
  name: string;
  risk: Risk;
  confidence: Confidence;
  description: string;
  solution: string | null;
  reference: string | null;
  cweId: number | null;
  wascId: number | null;
  instances: Array<{ uri: string; method: string | null; param: string | null; evidence: string | null }>;
  instanceCount: number;
}

const RISK: Record<string, Risk> = { "3": "HIGH", "2": "MEDIUM", "1": "LOW", "0": "INFO" };
const CONF: Record<string, Confidence> = { "4": "CONFIRMED", "3": "HIGH", "2": "MEDIUM", "1": "LOW", "0": "FALSE_POSITIVE" };
const MAX_ALERTS = 500;
const MAX_INSTANCES = 10;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** ZAP descriptions contain simple HTML (<p>); keep plain text only. */
export function stripHtml(v: unknown, max = 4000): string | null {
  const s = str(v, max * 2);
  if (!s) return null;
  return s
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
    .slice(0, max);
}

const int = (v: unknown): number | null => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function sameHost(uri: string, host: string) {
  try {
    return new URL(uri).hostname.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function parseZapReport(raw: unknown, targetHost: string): ScanAlert[] {
  const sites = (raw as { site?: unknown })?.site;
  if (!Array.isArray(sites)) throw new Error("Not a ZAP traditional JSON report (missing site array)");
  const byKey = new Map<string, ScanAlert>();
  for (const site of sites) {
    const s = site as { "@host"?: unknown; alerts?: unknown };
    if (String(s["@host"] ?? "").toLowerCase() !== targetHost.toLowerCase()) continue; // out of scope
    if (!Array.isArray(s.alerts)) continue;
    for (const a of s.alerts as Array<Record<string, unknown>>) {
      const pluginId = str(a.pluginid, 20);
      const risk = RISK[String(a.riskcode)];
      const name = str(a.alert ?? a.name, 300);
      if (!pluginId || !risk || !name) continue;
      const instances = (Array.isArray(a.instances) ? (a.instances as Array<Record<string, unknown>>) : [])
        .map((i) => ({ uri: str(i.uri, 1000) ?? "", method: str(i.method, 12), param: str(i.param, 200), evidence: str(i.evidence, 300) }))
        .filter((i) => i.uri && sameHost(i.uri, targetHost));
      if (Array.isArray(a.instances) && a.instances.length && !instances.length) continue; // only off-target instances
      const alertRef = str(a.alertRef, 40);
      const key = `${pluginId}:${alertRef ?? ""}`;
      const count = int(a.count) ?? instances.length;
      const existing = byKey.get(key);
      if (existing) {
        existing.instances.push(...instances.slice(0, MAX_INSTANCES - existing.instances.length));
        existing.instanceCount += count;
        continue;
      }
      if (byKey.size >= MAX_ALERTS) break;
      byKey.set(key, {
        pluginId,
        alertRef,
        name,
        risk,
        confidence: CONF[String(a.confidence)] ?? "MEDIUM",
        description: stripHtml(a.desc) ?? name,
        solution: stripHtml(a.solution),
        reference: stripHtml(a.reference, 2000),
        cweId: int(a.cweid),
        wascId: int(a.wascid),
        instances: instances.slice(0, MAX_INSTANCES),
        instanceCount: count,
      });
    }
  }
  const order: Record<Risk, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
  return [...byKey.values()].sort((x, y) => order[x.risk] - order[y.risk] || x.name.localeCompare(y.name));
}

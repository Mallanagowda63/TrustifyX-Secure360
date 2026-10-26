"use client";

import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { AiPanel } from "@/components/AiPanel";
import { Empty, FindingStatusBadge, Notice, SEVERITIES, SeverityBadge } from "@/components/ui";
import { fmtDate, timeAgo } from "@/lib/format";

type Severity = (typeof SEVERITIES)[number];
type Status = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "FALSE_POSITIVE";

export interface FindingRow {
  id: string;
  ruleId: string;
  category: string;
  title: string;
  severity: Severity;
  status: Status;
  evidence: Record<string, unknown>;
  description: string;
  remediation: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  statusNote: string | null;
  websiteId: string;
  website: { id: string; displayName: string; hostname: string };
}

const STATUSES: Array<{ v: Status; label: string }> = [
  { v: "OPEN", label: "Open" },
  { v: "IN_PROGRESS", label: "In Progress" },
  { v: "RESOLVED", label: "Resolved" },
  { v: "FALSE_POSITIVE", label: "False Positive" },
];

export function FindingsView({
  initial,
  selectedId,
  canUpdate,
  canScan,
  aiEnabled,
}: {
  initial: FindingRow[];
  selectedId: string | null;
  canUpdate: boolean;
  canScan: boolean;
  aiEnabled: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const [statusFilter, setStatusFilter] = useState<Status[]>(["OPEN", "IN_PROGRESS"]);
  const [sevFilter, setSevFilter] = useState<Severity | "ALL">("ALL");
  const [siteFilter, setSiteFilter] = useState("ALL");
  const [selected, setSelected] = useState<string | null>(selectedId);

  const sites = useMemo(() => [...new Map(rows.map((r) => [r.website.id, r.website])).values()], [rows]);
  const visible = rows.filter(
    (r) =>
      (statusFilter.length === 0 || statusFilter.includes(r.status) || r.id === selectedId) &&
      (sevFilter === "ALL" || r.severity === sevFilter) &&
      (siteFilter === "ALL" || r.website.id === siteFilter),
  );
  const current = rows.find((r) => r.id === selected) ?? null;

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_28rem]">
      <div className="card p-4">
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <div className="flex flex-wrap gap-1">
            {STATUSES.map((s) => {
              const on = statusFilter.includes(s.v);
              return (
                <button
                  key={s.v}
                  className={`btn py-1 ${on ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setStatusFilter((f) => (on ? f.filter((x) => x !== s.v) : [...f, s.v]))}
                  aria-pressed={on}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <select className="input w-auto py-1" value={sevFilter} onChange={(e) => setSevFilter(e.target.value as Severity | "ALL")} aria-label="Severity">
            <option value="ALL">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className="input w-auto py-1" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} aria-label="Website">
            <option value="ALL">All websites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.hostname}
              </option>
            ))}
          </select>
        </div>
        {visible.length === 0 ? (
          <Empty>No findings match these filters.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Finding</th>
                  <th>Website</th>
                  <th>Status</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((f) => (
                  <tr key={f.id} onClick={() => setSelected(f.id)} className={`cursor-pointer ${selected === f.id ? "bg-navy-800" : ""}`}>
                    <td><SeverityBadge severity={f.severity} /></td>
                    <td className="font-medium">{f.title}</td>
                    <td className="text-ink-muted">{f.website.hostname}</td>
                    <td><FindingStatusBadge status={f.status} /></td>
                    <td className="whitespace-nowrap text-ink-muted">{timeAgo(f.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        {current ? (
          <FindingDetail
            key={current.id}
            f={current}
            canUpdate={canUpdate}
            canScan={canScan}
            aiEnabled={aiEnabled}
            onUpdated={(u) => setRows((rs) => rs.map((r) => (r.id === u.id ? { ...r, ...u } : r)))}
          />
        ) : (
          <div className="card p-5 text-sm text-ink-muted">Select a finding to see its evidence and remediation.</div>
        )}
      </div>
    </div>
  );
}

function FindingDetail({
  f,
  canUpdate,
  canScan,
  aiEnabled,
  onUpdated,
}: {
  f: FindingRow;
  canUpdate: boolean;
  canScan: boolean;
  aiEnabled: boolean;
  onUpdated: (f: FindingRow) => void;
}) {
  const [status, setStatus] = useState<Status>(f.status);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const { finding } = await api<{ finding: FindingRow }>(`/api/findings/${f.id}`, { method: "PATCH", body: { status, note: note || undefined } });
      onUpdated(JSON.parse(JSON.stringify(finding)));
      setMsg({ tone: "success", text: status === "RESOLVED" ? "Marked resolved. A verification rescan has been queued; it reopens automatically if still observed." : "Status updated." });
      setNote("");
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function rescan() {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/findings/${f.id}/rescan`, { method: "POST" });
      setMsg({ tone: "success", text: "Rescan queued. Refresh in about a minute to see the result." });
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card sticky top-20 space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <FindingStatusBadge status={f.status} />
        <span className="text-xs text-ink-faint">{f.category.toUpperCase()} · {f.ruleId}</span>
      </div>
      <h2 className="text-lg font-semibold">{f.title}</h2>
      <div className="text-sm text-ink-muted">
        {f.website.displayName} ({f.website.hostname})
        <br />
        First seen {fmtDate(f.firstSeenAt)} · last seen {fmtDate(f.lastSeenAt)}
        {f.resolvedAt && <><br />Resolved {fmtDate(f.resolvedAt)}</>}
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Why it matters</h3>
        <p className="text-sm leading-relaxed text-ink-muted">{f.description}</p>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Recommended remediation</h3>
        <p className="text-sm leading-relaxed text-ink-muted">{f.remediation}</p>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Evidence</h3>
        <pre className="max-h-64 overflow-auto rounded-md border border-navy-700 bg-navy-950 p-3 text-xs">{JSON.stringify(f.evidence, null, 2)}</pre>
      </div>
      {f.statusNote && <p className="text-xs text-ink-faint">Note: {f.statusNote}</p>}
      <AiPanel endpoint="/api/ai/explain-finding" body={{ findingId: f.id }} label="Explain with AI" enabled={aiEnabled} compact />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {(canUpdate || canScan) && (
        <div className="space-y-2 border-t border-navy-700 pt-4">
          {canUpdate && (
            <>
              <div className="flex gap-2">
                <select className="input" value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label="Status">
                  {STATUSES.map((s) => (
                    <option key={s.v} value={s.v}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button className="btn btn-primary" disabled={busy || (status === f.status && !note)} onClick={save}>
                  Update
                </button>
              </div>
              <textarea
                className="input min-h-16 text-sm"
                placeholder={status === "FALSE_POSITIVE" ? "Required: why is this a false positive?" : "Optional note"}
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}
          {canScan && (
            <button className="btn btn-ghost w-full" disabled={busy} onClick={rescan}>
              ↻ Rescan website to verify fix
            </button>
          )}
        </div>
      )}
    </div>
  );
}

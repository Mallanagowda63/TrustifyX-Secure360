import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageSession } from "@/server/auth/page";
import { getScan } from "@/server/scanning/service";
import { ApiError } from "@/server/api";
import { Notice, PageHeader, Section } from "@/components/ui";

export const dynamic = "force-dynamic";

const RISK: Record<string, string> = {
  HIGH: "border-orange-400/60 bg-orange-500/10 text-orange-200",
  MEDIUM: "border-amber-400/60 bg-amber-400/10 text-amber-200",
  LOW: "border-sky-400/50 bg-sky-500/10 text-sky-200",
  INFO: "border-slate-500/50 text-slate-300",
};

export default async function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requirePageSession("scan.read");
  const { id } = await params;
  const scan = await getScan(s.org.id, id).catch((err) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const stats = (scan.stats ?? {}) as { allowed?: number; refused?: number; refusedHosts?: string[]; durationMs?: number };
  const counts = ["HIGH", "MEDIUM", "LOW", "INFO"].map((r) => ({ r, n: scan.findings.filter((f) => f.risk === r).length }));
  return (
    <div className="space-y-6">
      <PageHeader
        title={`Scan results · ${scan.website.hostname}`}
        subtitle={`${scan.type === "ACTIVE" ? "Active" : "Passive baseline"} OWASP ZAP scan · ${scan.finishedAt ? `finished ${scan.finishedAt.toLocaleString()}` : scan.status.toLowerCase()}`}
        actions={
          scan.status === "COMPLETED" ? (
            <>
              <a className="btn btn-primary" href={`/api/scans/${scan.id}/report`}>Download PDF</a>
              <a className="btn" href={`/api/scans/${scan.id}/report?format=json`}>Download JSON</a>
            </>
          ) : null
        }
      />
      <p className="text-sm"><Link className="text-royal-300 hover:underline" href="/scans">← All scans</Link></p>
      {scan.status !== "COMPLETED" && <Notice tone={scan.status === "FAILED" ? "error" : "info"}>{scan.error ?? scan.message ?? "This scan has not completed."}</Notice>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {counts.map(({ r, n }) => (
          <div key={r} className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
            <div className="text-xs font-semibold tracking-wide text-slate-400 uppercase">{r === "INFO" ? "Informational" : `${r[0]}${r.slice(1).toLowerCase()} risk`}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{n}</div>
          </div>
        ))}
      </div>

      <Section title="Findings">
        {scan.findings.length === 0 ? (
          <p className="text-sm text-ink-muted">ZAP reported no alerts for this target. Automated scans cannot find every issue; this does not mean the website is secure.</p>
        ) : (
          <ul className="space-y-3">
            {scan.findings.map((f) => (
              <li key={f.id}>
                <details className="rounded-lg border border-navy-600 p-3">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${RISK[f.risk]}`}>{f.risk}</span>
                    <span className="font-medium">{f.name}</span>
                    <span className="text-xs text-ink-faint">
                      {f.instanceCount} instance{f.instanceCount === 1 ? "" : "s"} · confidence {f.confidence.toLowerCase().replace("_", " ")}
                      {f.cweId ? ` · CWE-${f.cweId}` : ""}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3 text-sm">
                    <p className="whitespace-pre-line text-ink-muted">{f.description}</p>
                    {f.solution && (
                      <div>
                        <p className="font-medium">Recommended fix</p>
                        <p className="whitespace-pre-line text-ink-muted">{f.solution}</p>
                      </div>
                    )}
                    {(f.instances as Array<{ uri: string; method: string | null; param: string | null; evidence: string | null }>).length > 0 && (
                      <div>
                        <p className="font-medium">Where (sample)</p>
                        <ul className="mt-1 space-y-1 font-mono text-xs break-all text-ink-muted">
                          {(f.instances as Array<{ uri: string; method: string | null; param: string | null; evidence: string | null }>).map((i, idx) => (
                            <li key={idx}>
                              {i.method ?? "GET"} {i.uri}
                              {i.param ? ` · parameter ${i.param}` : ""}
                              {i.evidence ? ` · evidence: ${i.evidence}` : ""}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {f.reference && <p className="text-xs break-all whitespace-pre-line text-ink-faint">References: {f.reference}</p>}
                    <p className="text-xs text-ink-faint">ZAP rule {f.pluginId}</p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Scope and authorization">
        <ul className="space-y-1 text-sm text-ink-muted">
          <li>Target: <span className="font-mono">{scan.targetUrl}</span> (no other host was reachable by the scanner)</li>
          {typeof stats.allowed === "number" && <li>Connections to the target: {stats.allowed} · out-of-scope requests refused: {stats.refused ?? 0}{stats.refusedHosts?.length ? ` (${stats.refusedHosts.slice(0, 5).join(", ")})` : ""}</li>}
          {typeof stats.durationMs === "number" && <li>Duration: {Math.round(stats.durationMs / 60000)} min</li>}
          <li>Authorized {scan.authorizedAt.toLocaleString()}: “{scan.authorizationText}”</li>
        </ul>
      </Section>
    </div>
  );
}

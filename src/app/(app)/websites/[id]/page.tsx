import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageSession } from "@/server/auth/page";
import { aiEnabled } from "@/server/ai/provider";
import { AiPanel } from "@/components/AiPanel";
import { can } from "@/server/auth/rbac";
import { ApiError } from "@/server/api";
import { prisma } from "@/server/db";
import {
  availabilitySeries,
  configChanges,
  getWebsiteForOrg,
  latestSnapshot,
  presentWebsite,
  recentChecks,
} from "@/server/services/websites";
import { listFindings } from "@/server/services/findings";
import type { ConfigObservation } from "@/server/monitoring/types";
import { Empty, FindingStatusBadge, Notice, PageHeader, Section, SeverityBadge, StateIndicator, WebsiteStatusBadge } from "@/components/ui";
import { duration, fmtDate, timeAgo } from "@/lib/format";
import { VerificationPanel } from "./verification-panel";
import { WebsiteActions } from "./website-actions";
import { SeriesPanel } from "./series-panel";

export default async function WebsiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const s = await requirePageSession("website.read");
  const { id } = await params;
  let site;
  try {
    site = await getWebsiteForOrg(s.org.id, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const w = presentWebsite(site);
  const monitored = site.status === "CONNECTED" || site.status === "MONITORING_PAUSED";

  const [series, checks, snapshot, changes, findings, incidents] = monitored
    ? await Promise.all([
        availabilitySeries(s.org.id, site.id, "24h"),
        recentChecks(s.org.id, site.id, 20),
        latestSnapshot(s.org.id, site.id),
        configChanges(s.org.id, site.id, 50),
        listFindings(s.org.id, { websiteId: site.id }),
        prisma.incident.findMany({ where: { orgId: s.org.id, websiteId: site.id }, orderBy: { startedAt: "desc" }, take: 20 }),
      ])
    : [null, [], null, [], [], []];

  const obs = snapshot
    ? ({
        tls: snapshot.tls,
        headers: snapshot.headers,
        https: snapshot.https,
        dns: snapshot.dns,
        errors: snapshot.errors ?? {},
      } as unknown as ConfigObservation)
    : null;

  return (
    <div className="space-y-6">
      <div className="text-sm">
        <Link href="/websites" className="text-ink-muted hover:text-ink">
          ← Websites
        </Link>
      </div>
      <PageHeader
        title={w.displayName}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-3">
            <span className="mono">{w.url}</span>
            <WebsiteStatusBadge status={w.status} />
            <StateIndicator state={w.state} status={w.status} />
          </span>
        }
        actions={
          <WebsiteActions
            website={{ id: w.id, status: w.status, displayName: w.displayName, availabilityIntervalSec: w.availabilityIntervalSec, configIntervalSec: w.configIntervalSec }}
            canScan={can(s.role, "website.scan")}
            canUpdate={can(s.role, "website.update")}
            canDelete={can(s.role, "website.delete")}
          />
        }
      />

      {w.lastVerificationError && site.status === "CONNECTED" && <Notice tone="warn">{w.lastVerificationError}</Notice>}

      {(site.status === "PENDING_VERIFICATION" || site.status === "VERIFICATION_FAILED") && (
        <VerificationPanel
          websiteId={w.id}
          hostname={w.hostname}
          instructions={w.verification}
          lastError={w.lastVerificationError}
          canVerify={can(s.role, "website.verify")}
          failed={site.status === "VERIFICATION_FAILED"}
        />
      )}

      {monitored && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Info label="Last availability check" value={timeAgo(w.lastAvailabilityCheckAt)} hint={fmtDate(w.lastAvailabilityCheckAt)} />
            <Info label="Last response" value={w.lastResponseTimeMs !== null ? `${w.lastResponseTimeMs} ms` : "—"} hint={w.lastStatusCode ? `HTTP ${w.lastStatusCode}` : undefined} />
            <Info
              label="TLS certificate"
              value={obs?.tls ? `${obs.tls.daysRemaining} days left` : "—"}
              hint={obs?.tls ? `Expires ${fmtDate(obs.tls.validTo)}` : "Awaiting configuration check"}
            />
            <Info label="Configuration checked" value={timeAgo(w.lastConfigCheckAt)} hint={`Every ${Math.round(w.configIntervalSec / 3600)}h · availability every ${Math.round(w.availabilityIntervalSec / 60)} min`} />
          </div>

          <SeriesPanel websiteId={w.id} initial={series!} />

          <Section title={`Findings (${findings.filter((f) => f.status === "OPEN" || f.status === "IN_PROGRESS").length} open)`}>
            {findings.length === 0 ? (
              <Empty>No findings recorded{w.lastConfigCheckAt ? "" : " yet. The first configuration check runs shortly after verification"}.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Finding</th>
                      <th>Status</th>
                      <th>First seen</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr key={f.id}>
                        <td><SeverityBadge severity={f.severity} /></td>
                        <td><Link href={`/findings?id=${f.id}`} className="hover:underline">{f.title}</Link></td>
                        <td><FindingStatusBadge status={f.status} /></td>
                        <td className="text-ink-muted">{fmtDate(f.firstSeenAt)}</td>
                        <td className="text-ink-muted">{timeAgo(f.lastSeenAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {obs && <ConfigurationDetails obs={obs} checkedAt={snapshot!.checkedAt} />}

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="Configuration changes">
              {changes.length === 0 ? (
                <Empty>No externally observable configuration changes detected yet.</Empty>
              ) : (
                <ul className="space-y-3 text-sm">
                  {changes.map((c) => (
                    <li key={c.id} className="border-b border-navy-800 pb-2">
                      <div className="font-medium">
                        {c.category.toUpperCase()} · {c.field}
                      </div>
                      <div className="text-xs text-ink-faint">{fmtDate(c.detectedAt)}</div>
                      <div className="mt-1 grid gap-1 text-xs">
                        <div className="break-all"><span className="text-ink-faint">Before: </span><span className="mono">{c.previousValue ?? "(none)"}</span></div>
                        <div className="break-all"><span className="text-ink-faint">After: </span><span className="mono">{c.newValue ?? "(none)"}</span></div>
                      </div>
                      {aiEnabled() && can(s.role, "ai.use") && (
                        <div className="mt-2">
                          <AiPanel endpoint="/api/ai/explain-change" body={{ changeId: c.id }} label="Explain this change" enabled compact />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Incidents">
              {incidents.length === 0 ? (
                <Empty>No incidents.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {incidents.map((i) => (
                    <li key={i.id} className="flex justify-between gap-3">
                      <span>{i.type === "DOWNTIME" ? "Downtime" : "TLS certificate expired"} · {fmtDate(i.startedAt)}</span>
                      <span className={i.resolvedAt ? "text-emerald-300" : "text-red-300"}>
                        {i.resolvedAt ? `✓ ${duration(i.startedAt, i.resolvedAt)}` : "● Ongoing"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section title="Recent availability checks">
            {checks.length === 0 ? (
              <Empty>No checks yet. The first check runs within a minute of verification.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Result</th>
                      <th>HTTP</th>
                      <th>Response</th>
                      <th>Redirects</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.id}>
                        <td className="whitespace-nowrap text-ink-muted">{fmtDate(c.checkedAt)}</td>
                        <td>{c.success ? <span className="text-emerald-300">✓ Up</span> : <span className="text-red-300">✕ Failed</span>}</td>
                        <td className="tabular-nums">{c.statusCode ?? "—"}</td>
                        <td className="tabular-nums">{c.responseTimeMs !== null ? `${c.responseTimeMs} ms` : "—"}</td>
                        <td className="tabular-nums">{c.redirectCount}</td>
                        <td className="max-w-md truncate text-xs text-ink-faint" title={c.error ?? c.finalUrl ?? ""}>{c.error ?? c.finalUrl}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Info({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs tracking-wide text-ink-muted uppercase">{label}</div>
      <div className="mt-1.5 text-lg font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 border-b border-navy-800 py-1.5 text-sm">
      <div className="text-ink-muted">{k}</div>
      <div className="min-w-0 break-all">{v ?? "—"}</div>
    </div>
  );
}

const present = (v: string | null | undefined) => (v ? <span className="mono text-xs">{v}</span> : <span className="text-amber-200">Not set</span>);

function ConfigurationDetails({ obs, checkedAt }: { obs: ConfigObservation; checkedAt: Date }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title={`TLS certificate · checked ${timeAgo(checkedAt)}`}>
        {obs.tls ? (
          <div>
            <Row k="Trusted" v={obs.tls.authorized && obs.tls.hostnameMatches ? "✓ Yes" : `✕ No${obs.tls.authorizationError ? ` (${obs.tls.authorizationError})` : ""}`} />
            <Row k="Subject" v={obs.tls.subjectCN} />
            <Row k="Issuer" v={obs.tls.issuer} />
            <Row k="Valid from" v={fmtDate(obs.tls.validFrom)} />
            <Row k="Valid until" v={`${fmtDate(obs.tls.validTo)} (${obs.tls.daysRemaining} days)`} />
            <Row k="Protocol" v={`${obs.tls.protocol ?? "—"} · ${obs.tls.cipher ?? ""}`} />
            <Row k="SANs" v={<span className="text-xs">{obs.tls.subjectAltNames.slice(0, 10).join(", ")}</span>} />
          </div>
        ) : (
          <Notice tone="warn">TLS check failed: {obs.errors.tls ?? "unknown error"}</Notice>
        )}
      </Section>
      <Section title="HTTP security headers">
        {obs.headers ? (
          <div>
            <Row k="HSTS" v={present(obs.headers.hsts.raw)} />
            <Row k="CSP" v={obs.headers.csp.reportOnly ? <span className="text-amber-200">Report-only</span> : present(obs.headers.csp.raw)} />
            <Row k="X-Content-Type-Options" v={present(obs.headers.xContentTypeOptions)} />
            <Row k="Referrer-Policy" v={present(obs.headers.referrerPolicy)} />
            <Row k="X-Frame-Options" v={present(obs.headers.xFrameOptions)} />
            <Row k="Permissions-Policy" v={present(obs.headers.permissionsPolicy)} />
            <Row k="HTTPS enforced" v={obs.https ? (obs.https.httpReachable ? (obs.https.redirectsToHttps ? "✓ HTTP redirects to HTTPS" : "✕ HTTP served without redirect") : "✓ Plain HTTP not served") : obs.errors.https ?? "—"} />
          </div>
        ) : (
          <Notice tone="warn">Header check failed: {obs.errors.headers ?? "unknown error"}</Notice>
        )}
      </Section>
      <Section title="DNS records">
        {obs.dns ? (
          <div>
            <Row k="A" v={obs.dns.A.join(", ") || "—"} />
            <Row k="AAAA" v={obs.dns.AAAA.join(", ") || "—"} />
            <Row k="CNAME" v={obs.dns.CNAME.join(", ") || "—"} />
            <Row k={`NS (${obs.dns.registrableDomain})`} v={obs.dns.NS.join(", ") || "—"} />
            <Row k="MX" v={obs.dns.MX.length === 1 && /^0 \.?$/.test(obs.dns.MX[0]) ? "Null MX (domain accepts no email)" : obs.dns.MX.join(", ") || "—"} />
            <Row k="CAA" v={obs.dns.CAA.join(", ") || "—"} />
            <Row k="SPF" v={obs.dns.spf} />
            <Row k="DMARC" v={obs.dns.dmarc} />
          </div>
        ) : (
          <Notice tone="warn">DNS check failed: {obs.errors.dns ?? "unknown error"}</Notice>
        )}
      </Section>
    </div>
  );
}

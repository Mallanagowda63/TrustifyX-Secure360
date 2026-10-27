import Link from "next/link";
import type { ReactNode } from "react";
import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { aiEnabled } from "@/server/ai/provider";
import { portalDashboard } from "@/server/services/portal";
import { POSTURE_METHODOLOGY } from "@/server/services/posture";
import { marketingUrl } from "@/server/sites";
import { ResponseTimeChart, UptimeChart } from "@/components/Charts";
import { AiPanel } from "@/components/AiPanel";
import { CheckWebsiteSecurity } from "@/components/portal/CheckWebsiteSecurity";
import { StatusChip } from "@/components/portal/StatusChip";
import { Icon } from "@/components/marketing/Icon";
import { Empty, SEVERITIES, SeverityBadge, severityColor } from "@/components/ui";
import { duration, fmtDate, timeAgo } from "@/lib/format";
import { DashboardExtras } from "./extras";

function Card({ title, value, hint, icon, tone = "default" }: { title: string; value: ReactNode; hint?: ReactNode; icon: string; tone?: "default" | "good" | "warn" | "bad" }) {
  const ring = { default: "text-royal-300", good: "text-emerald-300", warn: "text-amber-300", bad: "text-red-300" }[tone];
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{title}</span>
        <Icon name={icon} className={`h-4 w-4 ${ring}`} />
      </div>
      <div className="mt-2 text-2xl font-semibold text-white tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

function Panel({ id, title, children, actions }: { id?: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section id={id} className="min-w-0 rounded-xl border border-white/10 bg-[#0a1428] p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="font-display text-base font-bold text-white">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const yes = (v: boolean | null | undefined) =>
  v === null || v === undefined ? <span className="text-slate-600">—</span> : v ? <span className="text-emerald-300">✓<span className="sr-only"> present</span></span> : <span className="text-red-300">✕<span className="sr-only"> missing</span></span>;

export default async function PortalDashboard() {
  const s = await requirePageSession("website.read");
  const d = await portalDashboard(s.org.id);
  const t = d.totals;
  const plansUrl = marketingUrl("/#pricing");
  const hasSites = t.websites > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">Welcome to TrustifyX Secure360</h1>
          <p className="mt-1 text-slate-400">Your centralized cybersecurity monitoring platform.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/check" className="portal-btn-primary">+ Check Your Website Security</Link>
          {hasSites && <DashboardExtras />}
        </div>
      </div>

      {!hasSites ? (
        d.access.active ? (
          <CheckWebsiteSecurity plansUrl={plansUrl} canCreate={can(s.role, "website.create")} />
        ) : (
          <div className="rounded-2xl border border-white/10 bg-[#0a1428] p-8 text-center">
            <h2 className="font-display text-2xl font-bold text-white">{d.access.label}</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              {d.access.state === "PAYMENT_PENDING"
                ? "We are waiting for Razorpay to confirm your payment. Your plan activates automatically once it is confirmed."
                : "Choose a plan on the TrustifyX Secure360 website to connect and monitor your websites."}
            </p>
            {d.access.state !== "PAYMENT_PENDING" && <a className="portal-btn-primary mt-6" href={plansUrl}>View Pricing Plans</a>}
          </div>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Card
              title="Website status"
              icon="activity"
              tone={t.offline ? "bad" : t.online ? "good" : "default"}
              value={t.monitored ? `${t.online}/${t.monitored} online` : "Not monitored"}
              hint={t.offline ? `${t.offline} offline` : t.awaitingVerification ? `${t.awaitingVerification} awaiting verification` : t.initialScanRunning ? "Initial scan running" : "All monitored sites responding"}
            />
            <Card title="Uptime (30 days)" icon="radar" value={t.uptime30d !== null ? `${t.uptime30d}%` : "—"} hint="Successful availability checks" />
            <Card
              title="SSL certificate"
              icon="lock"
              tone={!t.tlsSoonest ? "default" : !t.tlsSoonest.trusted || t.tlsSoonest.daysRemaining < 7 ? "bad" : t.tlsSoonest.daysRemaining <= 30 ? "warn" : "good"}
              value={t.tlsSoonest ? (t.tlsSoonest.trusted ? `${t.tlsSoonest.daysRemaining} days` : "Untrusted") : "—"}
              hint={t.tlsSoonest ? `Nearest expiry · ${t.tlsSoonest.hostname}` : "After the first configuration check"}
            />
            <Card title="Security findings" icon="list" tone={d.severity.CRITICAL + d.severity.HIGH ? "bad" : t.openFindings ? "warn" : "good"} value={t.openFindings} hint={`${d.severity.CRITICAL} critical · ${d.severity.HIGH} high · ${d.severity.MEDIUM} medium`} />
            <Card title="Last checked" icon="bell" value={t.latestCheckAt ? timeAgo(t.latestCheckAt) : "—"} hint={t.latestCheckAt ? fmtDate(t.latestCheckAt) : "No checks yet"} />
            <Card
              title="Security posture"
              icon="shieldCheck"
              tone={!t.posture ? "default" : t.posture.score >= 90 ? "good" : t.posture.score >= 70 ? "warn" : "bad"}
              value={t.posture ? `${t.posture.score}/100` : "—"}
              hint={t.posture ? `${t.posture.grade} · see methodology` : "After the first configuration check"}
            />
          </div>
          <details className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-2 text-xs text-slate-400">
            <summary className="cursor-pointer text-slate-300">How the Security Posture Score is calculated (and what it does not cover)</summary>
            <p className="mt-2 leading-relaxed">{POSTURE_METHODOLOGY}</p>
          </details>

          <Panel id="monitoring" title="Website Monitoring" actions={<Link href="/websites" className="text-sm text-royal-300 hover:underline">My websites</Link>}>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Website</th>
                    <th>Status</th>
                    <th>Uptime 24h</th>
                    <th>Response</th>
                    <th>Posture</th>
                    <th>Last check</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sites.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Link href={w.indicators.includes("VERIFICATION_REQUIRED") ? `/check?site=${w.id}` : `/websites/${w.id}`} className="font-medium text-white hover:underline">{w.displayName}</Link>
                        <div className="text-xs text-slate-500">{w.hostname}</div>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-1">{w.indicators.map((i) => <StatusChip key={i} indicator={i} />)}</div>
                      </td>
                      <td className="tabular-nums">{w.uptime24h !== null ? `${w.uptime24h}%` : "—"}</td>
                      <td className="tabular-nums">{w.responseTimeMs !== null ? `${w.responseTimeMs} ms` : "—"}</td>
                      <td className="tabular-nums">{w.posture ? `${w.posture.score}` : "—"}</td>
                      <td className="text-slate-400">{timeAgo(w.lastCheckedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title={`Uptime · last 30 days${d.uptime30d.uptimePercent !== null ? ` · ${d.uptime30d.uptimePercent}%` : ""}`}>
              <UptimeChart points={d.uptime30d.points} span="long" />
            </Panel>
            <Panel title="Average response time · last 24 hours">
              <ResponseTimeChart points={d.response24h.points} span="short" />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Panel title="SSL/TLS Security">
              <ul className="space-y-3 text-sm">
                {d.sites.map((w) => (
                  <li key={w.id} className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-all text-slate-300">{w.hostname}</span>
                    {w.tls ? (
                      <span className={`text-right ${!w.tls.trusted || w.tls.daysRemaining < 7 ? "text-red-300" : w.tls.daysRemaining <= 30 ? "text-amber-200" : "text-emerald-300"}`}>
                        {w.tls.trusted ? "Trusted" : "Not trusted"} · {w.tls.daysRemaining} days
                        <span className="block text-xs text-slate-500">{w.tls.issuer} · {w.tls.protocol}</span>
                      </span>
                    ) : (
                      <span className="text-slate-500">Pending</span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title="Security Headers">
              <div className="overflow-x-auto">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th title="Strict-Transport-Security">HSTS</th>
                      <th title="Content-Security-Policy">CSP</th>
                      <th title="X-Content-Type-Options">XCTO</th>
                      <th title="Referrer-Policy">Ref.</th>
                      <th title="X-Frame-Options / frame-ancestors">Frame</th>
                      <th title="HTTP redirects to HTTPS">HTTPS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.sites.map((w) => (
                      <tr key={w.id}>
                        <td className="max-w-28 truncate text-slate-300">{w.hostname}</td>
                        <td>{yes(w.headers?.hsts)}</td>
                        <td>{yes(w.headers?.csp)}</td>
                        <td>{yes(w.headers?.xContentTypeOptions)}</td>
                        <td>{yes(w.headers?.referrerPolicy)}</td>
                        <td>{yes(w.headers?.framing)}</td>
                        <td>{yes(w.httpsEnforced)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="DNS Monitoring">
              <ul className="space-y-3 text-sm">
                {d.sites.map((w) => (
                  <li key={w.id}>
                    <div className="flex justify-between gap-2">
                      <span className="min-w-0 break-all text-slate-300">{w.hostname}</span>
                      {w.dns ? <span className="text-xs text-slate-500">{w.dns.a} A · {w.dns.aaaa} AAAA</span> : <span className="text-slate-500">Pending</span>}
                    </div>
                    {w.dns && (
                      <div className="mt-1 flex gap-3 text-xs text-slate-400">
                        <span>CAA {yes(w.dns.caa)}</span>
                        <span>SPF {yes(w.dns.spf)}</span>
                        <span>DMARC {yes(w.dns.dmarc)}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Panel title="Security Findings" actions={<Link href="/findings" className="text-sm text-royal-300 hover:underline">All findings</Link>}>
              <ul className="mb-4 space-y-2">
                {SEVERITIES.map((sev) => {
                  const max = Math.max(1, ...Object.values(d.severity));
                  return (
                    <li key={sev} className="flex items-center gap-3">
                      <div className="w-24 shrink-0"><SeverityBadge severity={sev} /></div>
                      <div className="h-2 flex-1 rounded-full bg-white/5">
                        <div className="h-2 rounded-full" style={{ width: `${(d.severity[sev] / max) * 100}%`, background: severityColor(sev), minWidth: d.severity[sev] ? 6 : 0 }} />
                      </div>
                      <span className="w-6 text-right text-sm tabular-nums">{d.severity[sev]}</span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
            <div className="min-w-0 lg:col-span-2">
              <Panel title="Highest-priority open findings">
                {d.topFindings.length === 0 ? (
                  <Empty>No open findings{t.initialScanRunning ? " yet. The initial scan is still running" : ""}.</Empty>
                ) : (
                  <ul className="divide-y divide-white/5 text-sm">
                    {d.topFindings.map((f) => (
                      <li key={f.id} className="flex items-center justify-between gap-3 py-2.5">
                        <span className="flex min-w-0 items-center gap-3">
                          <SeverityBadge severity={f.severity} />
                          <Link href={`/findings?id=${f.id}`} className="truncate text-slate-200 hover:underline">{f.title}</Link>
                        </span>
                        <span className="hidden shrink-0 text-xs text-slate-500 sm:inline">{f.hostname}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>

          <Panel title="AI Security Recommendations">
            {!d.access.limits.aiAssistant ? (
              <p className="text-sm text-slate-400">
                AI explanations are included in the Growth and Business plans.{" "}
                <a className="text-royal-300 underline" href="/sso/open?target=marketing&next=%2Faccount%2Fbilling">Upgrade</a>
              </p>
            ) : !can(s.role, "ai.use") ? (
              <p className="text-sm text-slate-400">Your role cannot use the AI assistant.</p>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-400">Prioritised next steps generated only from your verified monitoring data. The AI never changes your systems.</p>
                <AiPanel endpoint="/api/ai/prioritize" label="Generate recommendations" enabled={aiEnabled()} />
              </>
            )}
          </Panel>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title="Alerts and Notifications" actions={<Link href="/incidents" className="text-sm text-royal-300 hover:underline">All alerts</Link>}>
              {d.alerts.length === 0 ? (
                <Empty>No alerts yet.</Empty>
              ) : (
                <ul className="space-y-3 text-sm">
                  {d.alerts.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0 truncate text-slate-200">{a.subject}</span>
                      <span className="shrink-0 text-xs text-slate-500">{a.status.toLowerCase()} · {timeAgo(a.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Monitoring History">
              {d.incidents.length === 0 && d.changes.length === 0 ? (
                <Empty>No incidents or configuration changes recorded yet.</Empty>
              ) : (
                <ul className="space-y-3 text-sm">
                  {d.incidents.map((i) => (
                    <li key={i.id} className="flex justify-between gap-3">
                      <span className="text-slate-200">{i.type === "DOWNTIME" ? "Downtime" : "TLS certificate expired"} · {i.website.hostname}</span>
                      <span className={`shrink-0 text-xs ${i.resolvedAt ? "text-emerald-300" : "text-red-300"}`}>{i.resolvedAt ? `resolved · ${duration(i.startedAt, i.resolvedAt)}` : "ongoing"}</span>
                    </li>
                  ))}
                  {d.changes.map((c) => (
                    <li key={c.id} className="flex justify-between gap-3">
                      <span className="text-slate-300">{c.category.toUpperCase()} {c.field} changed · {c.website.hostname}</span>
                      <span className="shrink-0 text-xs text-slate-500">{timeAgo(c.detectedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel title="Download Security Report">
            <p className="mb-4 text-sm text-slate-400">PDF reports built from your real monitoring data: availability, incidents, findings and configuration changes.</p>
            <div className="flex flex-wrap gap-3">
              <a className="portal-btn-primary" href="/api/reports/pdf?period=weekly">⤓ Last 7 days</a>
              <a className="btn btn-ghost" href="/api/reports/pdf?period=monthly">⤓ Last 30 days</a>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

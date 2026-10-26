import Link from "next/link";
import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { aiEnabled } from "@/server/ai/provider";
import { getEntitlement } from "@/server/billing/entitlements";
import { AiPanel } from "@/components/AiPanel";
import { dashboardData } from "@/server/services/dashboard";
import { ResponseTimeChart, UptimeChart } from "@/components/Charts";
import {
  Empty,
  FindingStatusBadge,
  Notice,
  PageHeader,
  Section,
  SEVERITIES,
  SeverityBadge,
  severityColor,
  StatCard,
  StateIndicator,
  WebsiteStatusBadge,
} from "@/components/ui";
import { demoDashboard } from "@/lib/demo";
import { duration, fmtDate, timeAgo } from "@/lib/format";
import { DashboardExtras } from "./extras";

export default async function DashboardPage() {
  const s = await requirePageSession("website.read");
  const data = await dashboardData(s.org.id);

  if (data.totals.websites === 0) return <DemoDashboard />;

  const totalOpen = Object.values(data.severityCounts).reduce((a, b) => a + b, 0);
  const tlsSoonest = data.sites
    .filter((x) => x.tlsDaysRemaining !== null && x.status === "CONNECTED")
    .sort((a, b) => a.tlsDaysRemaining! - b.tlsDaysRemaining!)[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security overview"
        subtitle={`Latest monitoring check: ${data.totals.latestCheckAt ? `${timeAgo(data.totals.latestCheckAt)} (${fmtDate(data.totals.latestCheckAt)})` : "no checks yet"}`}
        actions={<DashboardExtras />}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Connected websites" value={data.totals.connected} hint={`${data.totals.websites} total · ${data.totals.pending} awaiting verification`} />
        <StatCard label="Online" value={<span>{data.totals.online}</span>} hint="Responding to checks" />
        <StatCard
          label="Offline"
          value={<span className={data.totals.offline ? "text-red-300" : undefined}>{data.totals.offline}</span>}
          hint="Confirmed downtime"
        />
        <StatCard label="Open findings" value={totalOpen} hint={`${data.severityCounts.CRITICAL + data.severityCounts.HIGH} critical/high`} />
        <StatCard
          label="Nearest TLS expiry"
          value={tlsSoonest ? `${tlsSoonest.tlsDaysRemaining} days` : "—"}
          hint={tlsSoonest ? tlsSoonest.hostname : "No certificate data yet"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={`Uptime · last 30 days${data.uptime30d.uptimePercent !== null ? ` · ${data.uptime30d.uptimePercent}%` : ""}`}>
          <UptimeChart points={data.uptime30d.points} span="long" />
        </Section>
        <Section title="Average response time · last 24 hours">
          <ResponseTimeChart points={data.response24h.points} span="short" />
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Open findings by severity">
          <SeverityBreakdown counts={data.severityCounts} />
        </Section>
        <div className="lg:col-span-2">
          <Section title="Websites" actions={<Link href="/websites" className="text-sm text-brand hover:underline">Manage</Link>}>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Website</th>
                    <th>Status</th>
                    <th>State</th>
                    <th>Uptime 24h</th>
                    <th>Response</th>
                    <th>TLS expiry</th>
                    <th>Last check</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sites.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <Link href={`/websites/${w.id}`} className="font-medium hover:underline">
                          {w.displayName}
                        </Link>
                        <div className="text-xs text-ink-faint">{w.hostname}</div>
                      </td>
                      <td><WebsiteStatusBadge status={w.status} /></td>
                      <td><StateIndicator state={w.state} status={w.status} /></td>
                      <td className="tabular-nums">{w.uptime24h !== null ? `${w.uptime24h}%` : "—"}</td>
                      <td className="tabular-nums">{w.lastResponseTimeMs !== null ? `${w.lastResponseTimeMs} ms` : "—"}</td>
                      <td className="tabular-nums">{w.tlsDaysRemaining !== null ? `${w.tlsDaysRemaining} d` : "—"}</td>
                      <td className="text-ink-muted">{timeAgo(w.lastAvailabilityCheckAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </div>

      <Section title="AI security recommendations">
        {can(s.role, "ai.use") ? (
          <>
            <p className="mb-3 text-sm text-ink-muted">Prioritised next steps generated from your open findings, incidents and certificate data.</p>
            {(await getEntitlement(s.org.id)).limits.aiAssistant ? (
              <AiPanel endpoint="/api/ai/prioritize" label="Generate recommendations" enabled={aiEnabled()} />
            ) : (
              <Empty>AI recommendations are included in the Growth and Business plans.</Empty>
            )}
          </>
        ) : (
          <Empty>AI recommendations are available to members and above.</Empty>
        )}
      </Section>

      <Section title="Highest-priority open findings" actions={<Link href="/findings" className="text-sm text-brand hover:underline">All findings</Link>}>
        {data.topFindings.length === 0 ? (
          <Empty>No open findings. Configuration checks run every few hours; use “Rescan” on a website to check now.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Finding</th>
                  <th>Website</th>
                  <th>Status</th>
                  <th>Last observed</th>
                </tr>
              </thead>
              <tbody>
                {data.topFindings.map((f) => (
                  <tr key={f.id}>
                    <td><SeverityBadge severity={f.severity} /></td>
                    <td>
                      <Link href={`/findings?id=${f.id}`} className="hover:underline">{f.title}</Link>
                    </td>
                    <td className="text-ink-muted">{f.website.hostname}</td>
                    <td><FindingStatusBadge status={f.status} /></td>
                    <td className="text-ink-muted">{timeAgo(f.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Recent incidents" actions={<Link href="/incidents" className="text-sm text-brand hover:underline">History</Link>}>
          {data.incidents.length === 0 ? (
            <Empty>No incidents recorded.</Empty>
          ) : (
            <ul className="space-y-3 text-sm">
              {data.incidents.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">
                      {i.type === "DOWNTIME" ? "Downtime" : i.type === "TLS_EXPIRY" ? "TLS certificate expired" : "TLS invalid"} · {i.website.hostname}
                    </div>
                    <div className="text-xs text-ink-faint">Started {fmtDate(i.startedAt)} · {duration(i.startedAt, i.resolvedAt)}</div>
                  </div>
                  <span className={`text-xs whitespace-nowrap ${i.resolvedAt ? "text-emerald-300" : "text-red-300"}`}>
                    {i.resolvedAt ? "✓ Resolved" : "● Ongoing"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Recent alerts">
          {data.alerts.length === 0 ? (
            <Empty>No alerts sent yet.</Empty>
          ) : (
            <ul className="space-y-3 text-sm">
              {data.alerts.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{a.subject}</div>
                    <div className="text-xs text-ink-faint">{a.recipient} · {timeAgo(a.createdAt)}</div>
                  </div>
                  <span className="text-xs whitespace-nowrap text-ink-muted">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function SeverityBreakdown({ counts }: { counts: Record<(typeof SEVERITIES)[number], number> }) {
  const max = Math.max(1, ...Object.values(counts));
  return (
    <ul className="space-y-3">
      {SEVERITIES.map((sev) => (
        <li key={sev} className="flex items-center gap-3">
          <div className="w-24 shrink-0">
            <SeverityBadge severity={sev} />
          </div>
          <div className="h-2.5 flex-1 rounded-full bg-navy-800">
            <div className="h-2.5 rounded-full" style={{ width: `${(counts[sev] / max) * 100}%`, background: severityColor(sev), minWidth: counts[sev] ? 6 : 0 }} />
          </div>
          <div className="w-8 text-right text-sm font-semibold tabular-nums">{counts[sev]}</div>
        </li>
      ))}
    </ul>
  );
}

function DemoDashboard() {
  const d = demoDashboard();
  return (
    <div className="space-y-6">
      <PageHeader title="Security overview" />
      <Notice tone="warn">
        <b>Demonstration data.</b> Your organization has no websites yet, so this preview shows sample values that are not real monitoring results.{" "}
        <Link href="/websites" className="font-semibold underline">Add your first website</Link> to see live data.
      </Notice>
      <div className="pointer-events-none space-y-6 opacity-80 select-none" aria-label="Demonstration data preview">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Connected websites (demo)" value={d.totals.connected} />
          <StatCard label="Online (demo)" value={d.totals.online} />
          <StatCard label="Open findings (demo)" value={7} />
          <StatCard label="Nearest TLS expiry (demo)" value="12 days" />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Uptime · last 30 days (demo)">
            <UptimeChart points={d.uptime} span="long" />
          </Section>
          <Section title="Response time · last 24 hours (demo)">
            <ResponseTimeChart points={d.response} span="short" />
          </Section>
        </div>
        <Section title="Open findings by severity (demo)">
          <SeverityBreakdown counts={d.severityCounts} />
        </Section>
      </div>
    </div>
  );
}

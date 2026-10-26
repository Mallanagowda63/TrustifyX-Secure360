import Link from "next/link";
import { requirePageSession } from "@/server/auth/page";
import { listAlerts, listIncidents } from "@/server/services/dashboard";
import { Empty, PageHeader, Section } from "@/components/ui";
import { duration, fmtDate } from "@/lib/format";

const TYPE_LABEL: Record<string, string> = {
  DOWNTIME: "Downtime",
  RECOVERY: "Recovery",
  TLS_EXPIRY: "TLS expiry",
  TLS_INVALID: "TLS invalid",
  FINDING_NEW: "New finding",
  FINDING_RESOLVED: "Finding resolved",
  REPORT: "Report",
};

export default async function IncidentsPage() {
  const s = await requirePageSession("alert.read");
  const [incidents, alerts] = await Promise.all([listIncidents(s.org.id), listAlerts(s.org.id)]);
  return (
    <div className="space-y-6">
      <PageHeader
        title="Incidents & alerts"
        subtitle="Downtime is confirmed only after consecutive failed checks. Each event is notified once per recipient, with a recovery notice when it ends."
      />
      <Section title="Incident history">
        {incidents.length === 0 ? (
          <Empty>No incidents recorded.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Website</th>
                  <th>Started</th>
                  <th>Resolved</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td>{TYPE_LABEL[i.type] ?? i.type}</td>
                    <td>
                      <Link href={`/websites/${i.website.id}`} className="hover:underline">
                        {i.website.hostname}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{fmtDate(i.startedAt)}</td>
                    <td className="whitespace-nowrap">{i.resolvedAt ? fmtDate(i.resolvedAt) : <span className="text-red-300">● Ongoing</span>}</td>
                    <td className="tabular-nums">{duration(i.startedAt, i.resolvedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Alert log">
        {alerts.length === 0 ? (
          <Empty>No alerts yet. Configure who receives which alerts in Settings → Notifications.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Subject</th>
                  <th>Recipient</th>
                  <th>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap text-ink-muted">{fmtDate(a.createdAt)}</td>
                    <td className="whitespace-nowrap">{TYPE_LABEL[a.type] ?? a.type}</td>
                    <td>{a.subject}</td>
                    <td className="text-ink-muted">{a.recipient}</td>
                    <td title={a.error ?? ""}>
                      <span className={a.status === "SENT" ? "text-emerald-300" : a.status === "FAILED" ? "text-red-300" : "text-ink-muted"}>
                        {a.status === "SENT" ? "✓ Sent" : a.status === "FAILED" ? "✕ Failed" : a.status === "SKIPPED" ? "Skipped" : "Pending"}
                      </span>
                      {a.error && <div className="text-xs text-ink-faint">{a.error}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

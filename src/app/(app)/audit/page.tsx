import { requirePageSession } from "@/server/auth/page";
import { listAuditLogs } from "@/server/services/dashboard";
import { getEntitlement } from "@/server/billing/entitlements";
import Link from "next/link";
import { Empty, Notice, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function AuditPage() {
  const s = await requirePageSession("audit.read");
  const ent = await getEntitlement(s.org.id);
  if (!ent.limits.auditLogs) {
    return (
      <div>
        <PageHeader title="Audit log" />
        <Notice>
          Organization audit logs are included in the Business plan.{" "}
          <Link className="font-semibold underline" href="/billing">
            Upgrade
          </Link>
        </Notice>
      </div>
    );
  }
  const logs = await listAuditLogs(s.org.id);
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Security-relevant actions in this organization (latest 200)." />
      <Section title="Events">
        {logs.length === 0 ? (
          <Empty>No events yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>User</th>
                  <th>Target</th>
                  <th>IP</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap text-ink-muted">{fmtDate(l.createdAt)}</td>
                    <td className="mono text-xs">{l.action}</td>
                    <td>{l.userEmail ?? <span className="text-ink-faint">system</span>}</td>
                    <td className="text-xs text-ink-muted">{l.targetType ? `${l.targetType}:${l.targetId}` : "—"}</td>
                    <td className="text-xs text-ink-muted">{l.ip ?? "—"}</td>
                    <td className="max-w-sm truncate text-xs text-ink-faint" title={l.metadata ? JSON.stringify(l.metadata) : ""}>
                      {l.metadata ? JSON.stringify(l.metadata) : ""}
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

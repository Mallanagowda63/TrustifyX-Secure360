import { requirePageSession } from "@/server/auth/page";
import { prisma } from "@/server/db";
import { Empty, PageHeader, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function ReportsPage() {
  const s = await requirePageSession("report.read");
  const reports = await prisma.report.findMany({
    where: { orgId: s.org.id },
    orderBy: { periodStart: "desc" },
    take: 50,
    select: { id: true, period: true, periodStart: true, periodEnd: true, createdAt: true, aiSummary: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="PDF security reports built from your real monitoring data. Weekly and monthly reports are also emailed according to each member's notification settings."
      />
      <Section title="Download now">
        <div className="flex flex-wrap gap-3">
          <a className="btn btn-primary" href="/api/reports/pdf?period=weekly">
            ⤓ Last 7 days (PDF)
          </a>
          <a className="btn btn-primary" href="/api/reports/pdf?period=monthly">
            ⤓ Last 30 days (PDF)
          </a>
        </div>
      </Section>
      <Section title="Scheduled reports">
        {reports.length === 0 ? (
          <Empty>
            No scheduled reports yet. Weekly reports are generated every Monday and monthly reports on the 1st (07:00 UTC) for the previous
            period.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Covers</th>
                  <th>Generated</th>
                  <th>AI summary</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.period === "WEEKLY" ? "Weekly" : "Monthly"}</td>
                    <td className="whitespace-nowrap">
                      {r.periodStart.toISOString().slice(0, 10)} to {new Date(r.periodEnd.getTime() - 1).toISOString().slice(0, 10)}
                    </td>
                    <td className="text-ink-muted">{fmtDate(r.createdAt)}</td>
                    <td className="text-ink-muted">{r.aiSummary ? "Included" : "—"}</td>
                    <td className="text-right">
                      <a className="btn btn-ghost py-1" href={`/api/reports/${r.id}/pdf`}>
                        Download
                      </a>
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

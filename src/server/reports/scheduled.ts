import { Prisma, type ReportPeriod } from "@prisma/client";
import { prisma } from "../db";
import { getEntitlement } from "../billing/entitlements";
import { aiProvider } from "../ai/provider";
import { monthlySummary } from "../ai/assistant";
import { dispatchAlert } from "../alerts/notify";
import { renderEmail } from "../alerts/mailer";
import { buildReportSummary, previousPeriod, type ReportSummary } from "./data";
import { renderReportPdf } from "./pdf";

/** AI executive summary when a provider is configured; reports are complete without it. */
async function tryAiSummary(orgId: string, summary: ReportSummary): Promise<string | null> {
  if (!aiProvider()) return null;
  try {
    return (await monthlySummary({ orgId, userId: null, ip: "worker" }, summary)).answer;
  } catch (err) {
    console.error("[reports] AI summary skipped:", (err as Error).message);
    return null;
  }
}

/**
 * Generates and emails the report for the last complete week/month for every organization
 * with at least one website. Idempotent per (org, period, start) via the Report unique key
 * and the alert dedupe key, so retries never send duplicates.
 */
export async function runScheduledReports(period: ReportPeriod, now = new Date()) {
  const { start, end } = previousPeriod(period, now);
  const orgs = await prisma.organization.findMany({ where: { websites: { some: {} } }, select: { id: true, name: true } });
  let generated = 0;

  for (const org of orgs) {
    if (!(await getEntitlement(org.id)).limits.scheduledReports) continue;
    let report = await prisma.report.findUnique({ where: { orgId_period_periodStart: { orgId: org.id, period, periodStart: start } } });
    if (!report) {
      const summary = await buildReportSummary(org.id, period, start, end);
      const aiSummary = await tryAiSummary(org.id, summary);
      try {
        report = await prisma.report.create({
          data: { orgId: org.id, period, periodStart: start, periodEnd: end, summary: summary as unknown as Prisma.InputJsonValue, aiSummary },
        });
        generated++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }

    const summary = report.summary as unknown as ReportSummary;
    const pdf = await renderReportPdf(summary, report.aiSummary);
    const label = period === "WEEKLY" ? "Weekly" : "Monthly";
    const subject = `${label} security report · ${org.name} · ${start.toISOString().slice(0, 10)}`;
    const lines = [
      `Your ${label.toLowerCase()} TrustifyX Secure360 report for ${org.name} is attached.`,
      `Availability: ${summary.totals.uptimePercent ?? "no data"}${summary.totals.uptimePercent !== null ? "%" : ""} · incidents: ${summary.totals.incidents} · findings opened/resolved: ${summary.totals.findingsOpened}/${summary.totals.findingsResolved}.`,
    ];
    await dispatchAlert({
      orgId: org.id,
      type: "REPORT",
      kind: period === "WEEKLY" ? "weeklyReport" : "monthlyReport",
      dedupeKey: `report:${org.id}:${period}:${start.toISOString().slice(0, 10)}`,
      subject,
      text: lines.join("\n\n"),
      html: renderEmail(subject, lines),
      attachments: [{ filename: `secure360-${period.toLowerCase()}-${start.toISOString().slice(0, 10)}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  }
  return { organizations: orgs.length, generated };
}

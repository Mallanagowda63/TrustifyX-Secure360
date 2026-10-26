import { authedRoute, notFound } from "@/server/api";
import { prisma } from "@/server/db";
import type { ReportSummary } from "@/server/reports/data";
import { renderReportPdf } from "@/server/reports/pdf";

/** Re-renders a stored scheduled report. */
export const GET = authedRoute<{ id: string }>("report.read", async ({ ctx, params }) => {
  const r = await prisma.report.findFirst({ where: { id: params.id, orgId: ctx.org.id } });
  if (!r) throw notFound("Report");
  const pdf = await renderReportPdf(r.summary as unknown as ReportSummary, r.aiSummary);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="secure360-${r.period.toLowerCase()}-${r.periodStart.toISOString().slice(0, 10)}.pdf"`,
    },
  });
});

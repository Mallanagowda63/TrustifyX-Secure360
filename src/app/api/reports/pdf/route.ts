import { z } from "zod";
import { authedRoute } from "@/server/api";
import { audit } from "@/server/audit";
import { buildReportSummary, rollingPeriod } from "@/server/reports/data";
import { renderReportPdf } from "@/server/reports/pdf";

const period = z.enum(["weekly", "monthly"]).catch("monthly");

/** On-demand report for the last 7 or 30 days. */
export const GET = authedRoute("report.read", async ({ req, ctx }) => {
  const p = period.parse(req.nextUrl.searchParams.get("period")) === "weekly" ? "WEEKLY" : "MONTHLY";
  const { start, end } = rollingPeriod(p);
  const summary = await buildReportSummary(ctx.org.id, p, start, end);
  const pdf = await renderReportPdf(summary);
  await audit({ orgId: ctx.org.id, userId: ctx.user.id, ip: ctx.ip, action: "report.download", metadata: { period: p } });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="secure360-${p.toLowerCase()}-${end.toISOString().slice(0, 10)}.pdf"`,
    },
  });
});

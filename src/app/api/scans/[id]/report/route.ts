import { NextResponse } from "next/server";
import { ApiError, authedRoute } from "@/server/api";
import { getScan } from "@/server/scanning/service";
import { renderScanPdf } from "@/server/scanning/report-pdf";

/** Downloadable scan report: PDF (default) or JSON (?format=json). */
export const GET = authedRoute<{ id: string }>("scan.read", async ({ req, ctx, params }) => {
  const scan = await getScan(ctx.org.id, params.id);
  if (scan.status !== "COMPLETED") throw new ApiError(400, "The report is available when the scan has completed.", "not_completed");
  const name = `secure360-scan-${scan.website.hostname}-${scan.finishedAt?.toISOString().slice(0, 10) ?? "report"}`;
  if (req.nextUrl.searchParams.get("format") === "json") {
    const body = {
      target: scan.targetUrl,
      type: scan.type,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      authorization: { text: scan.authorizationText, at: scan.authorizedAt },
      findings: scan.findings.map((f) => ({ risk: f.risk, confidence: f.confidence, name: f.name, pluginId: f.pluginId, cweId: f.cweId, description: f.description, solution: f.solution, reference: f.reference, instances: f.instances, instanceCount: f.instanceCount })),
    };
    return new NextResponse(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${name}.json"` } });
  }
  const pdf = await renderScanPdf(scan, ctx.org.name);
  return new NextResponse(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}.pdf"` } });
});

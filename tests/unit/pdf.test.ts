import { describe, expect, it } from "vitest";
import { renderReportPdf } from "@/server/reports/pdf";
import type { ReportSummary } from "@/server/reports/data";

const sev = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0, INFO: 0 };
const summary: ReportSummary = {
  organization: "Acme",
  period: "MONTHLY",
  periodStart: "2026-09-01T00:00:00.000Z",
  periodEnd: "2026-10-01T00:00:00.000Z",
  generatedAt: "2026-10-01T07:00:00.000Z",
  totals: { websites: 1, monitored: 1, checks: 8640, uptimePercent: 99.95, incidents: 1, findingsOpened: 3, findingsResolved: 1, openFindings: sev, configChanges: 0 },
  sites: [{ hostname: "acme.example", displayName: "Acme", status: "CONNECTED", checks: 8640, uptimePercent: 99.95, avgResponseMs: 210, downtimeIncidents: 1, downtimeMinutes: 20, tlsValidTo: null, tlsDaysRemaining: 40, openFindings: sev }],
  topOpenFindings: [],
  incidents: [],
  configChanges: [],
};

const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("PDF report rendering", () => {
  it("renders a single page for a small report (no blank trailing page)", async () => {
    const pdf = await renderReportPdf(summary);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(1);
  });

  it("paginates long reports with footers on every page", async () => {
    const many = {
      ...summary,
      topOpenFindings: Array.from({ length: 15 }, (_, i) => ({ website: "acme.example", title: `Finding ${i}`, severity: "LOW" as const, firstSeen: summary.periodStart, remediation: "x ".repeat(120) })),
      configChanges: Array.from({ length: 30 }, () => ({ website: "acme.example", category: "dns", field: "A", before: "1.1.1.1", after: "2.2.2.2", detectedAt: summary.periodStart })),
    };
    const pdf = await renderReportPdf(many, "Summary text");
    expect(pageCount(pdf)).toBeGreaterThan(1);
    expect(pageCount(pdf)).toBeLessThan(6);
  });
});

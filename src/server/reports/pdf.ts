import PDFDocument from "pdfkit";
import type { ReportSummary } from "./data";

const NAVY = "#0b1530";
const INK = "#0f172a";
const MUTED = "#475569";
const RULE = "#cbd5e1";
const SEV_COLOR: Record<string, string> = { CRITICAL: "#b42318", HIGH: "#c2410c", MEDIUM: "#a16207", LOW: "#1d4ed8", INFO: "#475569" };

const d = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Renders a report summary to PDF. Only real monitoring data from `summary` is printed. */
export function renderReportPdf(summary: ReportSummary, aiSummary?: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `Secure360 ${summary.period.toLowerCase()} report`, Author: "TrustifyX Secure360" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - 96;

    // Header band
    doc.rect(0, 0, doc.page.width, 92).fill(NAVY);
    doc.fillColor("#93c5fd").font("Helvetica-Bold").fontSize(11).text("TrustifyX Secure360", 48, 26);
    doc.fillColor("#ffffff").fontSize(20).text(`${summary.period === "WEEKLY" ? "Weekly" : "Monthly"} security report`, 48, 42);
    doc.fillColor("#cbd5e1").font("Helvetica").fontSize(9).text(`${summary.organization} · ${day(summary.periodStart)} to ${day(summary.periodEnd)} · generated ${d(summary.generatedAt)}`, 48, 68);
    doc.y = 116;

    const heading = (t: string) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.moveDown(0.6).fillColor(INK).font("Helvetica-Bold").fontSize(13).text(t, 48);
      doc.moveTo(48, doc.y + 2).lineTo(48 + width, doc.y + 2).strokeColor(RULE).lineWidth(0.8).stroke();
      doc.moveDown(0.5).font("Helvetica").fontSize(10).fillColor(INK);
    };

    const table = (cols: Array<{ label: string; w: number; align?: "left" | "right" }>, rows: string[][]) => {
      const startX = 48;
      const drawRow = (cells: string[], bold: boolean) => {
        const heights = cells.map((c, i) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).heightOfString(c, { width: cols[i].w - 6 }));
        const h = Math.max(...heights) + 6;
        if (doc.y + h > doc.page.height - 60) doc.addPage();
        const y = doc.y;
        let x = startX;
        cells.forEach((c, i) => {
          doc.fillColor(bold ? MUTED : INK).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).text(c, x + 3, y + 3, { width: cols[i].w - 6, align: cols[i].align ?? "left" });
          x += cols[i].w;
        });
        doc.moveTo(startX, y + h).lineTo(startX + width, y + h).strokeColor(RULE).lineWidth(0.5).stroke();
        doc.y = y + h;
      };
      drawRow(cols.map((c) => c.label), true);
      rows.forEach((r) => drawRow(r, false));
      doc.x = 48;
      doc.moveDown(0.4);
    };

    // Key figures
    const t = summary.totals;
    const tiles: Array<[string, string]> = [
      ["Monitored websites", `${t.monitored} / ${t.websites}`],
      ["Availability", t.uptimePercent !== null ? `${t.uptimePercent}%` : "no data"],
      ["Incidents", String(t.incidents)],
      ["Findings opened / resolved", `${t.findingsOpened} / ${t.findingsResolved}`],
    ];
    const tileW = (width - 18) / 4;
    const tileY = doc.y;
    tiles.forEach(([label, value], i) => {
      const x = 48 + i * (tileW + 6);
      doc.roundedRect(x, tileY, tileW, 54, 6).fillAndStroke("#f1f5f9", RULE);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x + 8, tileY + 9, { width: tileW - 16 });
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(15).text(value, x + 8, tileY + 26, { width: tileW - 16 });
    });
    doc.y = tileY + 66;
    doc.x = 48;
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(`${t.checks.toLocaleString("en")} availability checks in this period · ${t.configChanges} configuration change(s) detected.`);

    if (aiSummary) {
      heading("Summary");
      doc.fillColor(INK).font("Helvetica").fontSize(10).text(aiSummary.replace(/[*#`]/g, ""), { width, lineGap: 2 });
      doc.fillColor(MUTED).fontSize(7.5).text("AI-generated from the monitoring data in this report. Verify before acting.", { width });
    }

    heading("Open findings by severity");
    const sevText = (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const).map((s) => `${s.charAt(0)}${s.slice(1).toLowerCase()}: ${t.openFindings[s]}`).join("    ");
    doc.text(sevText);

    heading("Websites");
    if (summary.sites.length === 0) doc.text("No websites have been added yet.");
    else
      table(
        [
          { label: "Website", w: 120 },
          { label: "Status", w: 70 },
          { label: "Uptime", w: 52, align: "right" },
          { label: "Avg resp.", w: 56, align: "right" },
          { label: "Downtime", w: 62, align: "right" },
          { label: "TLS expires", w: 70, align: "right" },
          { label: "Open C/H/M/L", w: width - 430, align: "right" },
        ],
        summary.sites.map((s) => [
          s.hostname,
          s.status.replace(/_/g, " ").toLowerCase(),
          s.uptimePercent !== null ? `${s.uptimePercent}%` : "—",
          s.avgResponseMs !== null ? `${s.avgResponseMs} ms` : "—",
          s.downtimeIncidents ? `${s.downtimeMinutes} min` : "0",
          s.tlsDaysRemaining !== null ? `${s.tlsDaysRemaining} days` : "—",
          `${s.openFindings.CRITICAL}/${s.openFindings.HIGH}/${s.openFindings.MEDIUM}/${s.openFindings.LOW}`,
        ]),
      );

    heading("Highest-priority open findings");
    if (summary.topOpenFindings.length === 0) doc.text("No open findings.");
    for (const f of summary.topOpenFindings) {
      if (doc.y > doc.page.height - 110) doc.addPage();
      doc.fillColor(SEV_COLOR[f.severity] ?? INK).font("Helvetica-Bold").fontSize(9).text(`[${f.severity}] `, { continued: true });
      doc.fillColor(INK).text(`${f.title} — ${f.website}`);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text(`Open since ${day(f.firstSeen)}. Fix: ${f.remediation}`, { width, lineGap: 1 });
      doc.moveDown(0.4);
    }

    heading("Incidents");
    if (summary.incidents.length === 0) doc.text("No incidents in this period.");
    else
      table(
        [
          { label: "Website", w: 150 },
          { label: "Type", w: 90 },
          { label: "Started", w: 110 },
          { label: "Resolved", w: 110 },
          { label: "Duration", w: width - 460, align: "right" },
        ],
        summary.incidents.map((i) => [i.website, i.type.replace(/_/g, " ").toLowerCase(), d(i.startedAt), i.resolvedAt ? d(i.resolvedAt) : "ongoing", `${i.minutes} min`]),
      );

    heading("Configuration changes");
    if (summary.configChanges.length === 0) doc.text("No externally observable configuration changes detected.");
    else
      table(
        [
          { label: "Website", w: 110 },
          { label: "Change", w: 100 },
          { label: "Before", w: 120 },
          { label: "After", w: 120 },
          { label: "Detected", w: width - 450 },
        ],
        summary.configChanges.map((c) => [c.website, `${c.category}.${c.field}`, (c.before ?? "(none)").slice(0, 120), (c.after ?? "(none)").slice(0, 120), d(c.detectedAt)]),
      );

    doc.moveDown(1).fillColor(MUTED).font("Helvetica").fontSize(7.5).text(
      "Scope: TrustifyX Secure360 performs passive, non-intrusive external checks (availability, TLS certificate, HTTP security headers, HTTPS redirect and DNS records) on verified websites only. It does not inspect server internals or traffic, so this report does not assess intrusion or attack activity.",
      48,
      undefined,
      { width },
    );

    // Footer page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would otherwise make pdfkit start a new page.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor(MUTED).fontSize(7.5).text(`TrustifyX Private Limited · Secure360 · page ${i + 1} of ${range.count}`, 48, doc.page.height - 34, { width, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}


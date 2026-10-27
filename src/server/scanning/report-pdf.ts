import PDFDocument from "pdfkit";
import type { VulnerabilityFinding, VulnerabilityScan } from "@prisma/client";

const NAVY = "#0b1530";
const INK = "#0f172a";
const MUTED = "#475569";
const RULE = "#cbd5e1";
const RISK_COLOR: Record<string, string> = { HIGH: "#c2410c", MEDIUM: "#a16207", LOW: "#1d4ed8", INFO: "#475569" };
const ts = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");

type ScanWithFindings = VulnerabilityScan & { website: { hostname: string }; findings: VulnerabilityFinding[] };

/** PDF of one scan: only the alerts ZAP reported for the authorized target, with remediation guidance. */
export function renderScanPdf(scan: ScanWithFindings, organization: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `Secure360 scan ${scan.website.hostname}`, Author: "TrustifyX Secure360" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const width = doc.page.width - 96;

    doc.rect(0, 0, doc.page.width, 92).fill(NAVY);
    doc.fillColor("#93c5fd").font("Helvetica-Bold").fontSize(11).text("TrustifyX Secure360", 48, 26);
    doc.fillColor("#ffffff").fontSize(20).text(`${scan.type === "ACTIVE" ? "Active" : "Passive baseline"} vulnerability scan`, 48, 42);
    doc.fillColor("#cbd5e1").font("Helvetica").fontSize(9).text(`${organization} · ${scan.website.hostname} · finished ${ts(scan.finishedAt)}`, 48, 68);
    doc.y = 116;

    const heading = (t: string) => {
      if (doc.y > doc.page.height - 140) doc.addPage();
      doc.moveDown(0.6).fillColor(INK).font("Helvetica-Bold").fontSize(13).text(t, 48);
      doc.moveTo(48, doc.y + 2).lineTo(48 + width, doc.y + 2).strokeColor(RULE).lineWidth(0.8).stroke();
      doc.moveDown(0.5).font("Helvetica").fontSize(10).fillColor(INK);
    };

    heading("Scope and method");
    doc.fillColor(MUTED).fontSize(9).text(`Target: ${scan.targetUrl} (only this origin was reachable by the scanner)`, { width });
    doc.text(`Engine: OWASP ZAP Automation Framework · ${scan.type === "ACTIVE" ? "spider, passive and active rules (destructive, brute-force and DoS tests excluded)" : "spider and passive rules only, no attack payloads"}`, { width });
    doc.text(`Started ${ts(scan.startedAt)} · finished ${ts(scan.finishedAt)}`, { width });
    doc.text(`Authorization recorded ${ts(scan.authorizedAt)}: ${scan.authorizationText}`, { width });

    const counts = ["HIGH", "MEDIUM", "LOW", "INFO"].map((r) => `${r[0]}${r.slice(1).toLowerCase()}: ${scan.findings.filter((f) => f.risk === r).length}`);
    heading("Summary");
    doc.fillColor(INK).fontSize(10).text(`${scan.findings.length} alert type${scan.findings.length === 1 ? "" : "s"} · ${counts.join(" · ")}`, { width });
    doc.fillColor(MUTED).fontSize(8).text(
      "Automated scan results can include false positives and cannot find every vulnerability. A clean result does not mean the website is secure.",
      { width },
    );

    heading("Findings");
    if (!scan.findings.length) doc.fillColor(MUTED).text("ZAP reported no alerts for this target.");
    for (const f of scan.findings) {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(0.4).font("Helvetica-Bold").fontSize(10).fillColor(RISK_COLOR[f.risk] ?? INK).text(`${f.risk}`, { continued: true }).fillColor(INK).text(`  ${f.name}`);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(`Confidence ${f.confidence.toLowerCase()} · ${f.instanceCount} instance${f.instanceCount === 1 ? "" : "s"}${f.cweId ? ` · CWE-${f.cweId}` : ""} · ZAP rule ${f.pluginId}`, { width });
      doc.fontSize(9).fillColor(INK).text(f.description.slice(0, 1500), { width });
      if (f.solution) doc.moveDown(0.2).font("Helvetica-Bold").text("Recommended fix", { width }).font("Helvetica").text(f.solution.slice(0, 1500), { width });
      const inst = (f.instances as Array<{ uri: string; method: string | null; param: string | null }>).slice(0, 3);
      if (inst.length) doc.moveDown(0.2).fontSize(8).fillColor(MUTED).text(inst.map((i) => `${i.method ?? "GET"} ${i.uri}${i.param ? ` (${i.param})` : ""}`).join("\n"), { width });
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would otherwise make pdfkit start a new page.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(7).fillColor(MUTED).text(`TrustifyX Secure360 · page ${i + 1} of ${range.count}`, 48, doc.page.height - 36, { width, align: "center", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

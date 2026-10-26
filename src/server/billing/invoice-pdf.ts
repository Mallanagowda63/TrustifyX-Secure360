import PDFDocument from "pdfkit";
import type { Invoice, Payment, PricingPlan, Subscription } from "@prisma/client";
import { env } from "../env";

const INK = "#0f172a";
const MUTED = "#475569";
const RULE = "#cbd5e1";

const rupees = (paise: number) => `INR ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "-");

/** Payment receipt / tax invoice for one captured payment. Tax wording must be reviewed before launch. */
export function renderInvoicePdf(inv: Invoice & { payment: Payment; subscription: Subscription & { plan: PricingPlan } }): Promise<Buffer> {
  const e = env();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: `Invoice ${inv.number}`, Author: e.BILLING_SELLER_NAME } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const width = doc.page.width - 100;
    const billed = inv.billedTo as { organization?: string; email?: string | null; name?: string | null };

    doc.rect(0, 0, doc.page.width, 80).fill("#0b1530");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18).text(inv.status === "VOID" ? "Receipt (refunded)" : "Payment receipt / Tax invoice", 50, 28);
    doc.fillColor("#93c5fd").font("Helvetica").fontSize(9).text("TrustifyX Secure360", 50, 54);
    doc.y = 104;

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(e.BILLING_SELLER_NAME);
    doc.font("Helvetica").fillColor(MUTED).fontSize(9);
    if (e.BILLING_SELLER_ADDRESS) doc.text(e.BILLING_SELLER_ADDRESS, { width: 260 });
    if (e.BILLING_SELLER_GSTIN) doc.text(`GSTIN: ${e.BILLING_SELLER_GSTIN}`);
    doc.text(e.SUPPORT_EMAIL);

    const metaTop = 104;
    const metaX = 330;
    const meta: Array<[string, string]> = [
      ["Invoice no.", inv.number],
      ["Issued", day(inv.issuedAt)],
      ["Payment ID", inv.payment.razorpayPaymentId],
      ["Status", inv.status === "VOID" ? "Refunded" : "Paid"],
    ];
    meta.forEach(([k, v], i) => {
      doc.fillColor(MUTED).fontSize(9).text(k, metaX, metaTop + i * 15, { width: 80 });
      doc.fillColor(INK).text(v, metaX + 80, metaTop + i * 15, { width: width - 280 });
    });

    doc.y = Math.max(doc.y, metaTop + 70) + 16;
    doc.x = 50;
    doc.fillColor(MUTED).fontSize(9).text("Billed to");
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(10).text(billed.organization ?? "-");
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text([billed.name, billed.email].filter(Boolean).join(" · "));

    doc.moveDown(1.2);
    const y = doc.y;
    doc.moveTo(50, y).lineTo(50 + width, y).strokeColor(RULE).stroke();
    doc.fillColor(MUTED).fontSize(9).text("Description", 50, y + 8);
    doc.text("Amount", 50, y + 8, { width, align: "right" });
    const plan = inv.subscription.plan;
    const desc = `Secure360 ${plan.name} plan (${inv.subscription.cycle === "ANNUAL" ? "annual" : "monthly"}) · ${day(inv.periodStart)} to ${day(inv.periodEnd)}`;
    doc.fillColor(INK).fontSize(10).text(desc, 50, y + 28, { width: width - 120 });
    doc.text(rupees(inv.subtotalPaise), 50, y + 28, { width, align: "right" });

    let ty = y + 70;
    const line = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(bold ? INK : MUTED).fontSize(10);
      doc.text(label, 300, ty, { width: 140 });
      doc.text(value, 50, ty, { width, align: "right" });
      ty += 18;
    };
    doc.moveTo(300, ty - 8).lineTo(50 + width, ty - 8).strokeColor(RULE).stroke();
    line("Subtotal", rupees(inv.subtotalPaise));
    line(`GST (${(inv.taxRateBp / 100).toFixed(2)}%)`, rupees(inv.taxPaise));
    line("Total paid", rupees(inv.totalPaise), true);
    if (inv.payment.refundedPaise > 0) line("Refunded", `- ${rupees(inv.payment.refundedPaise)}`);

    doc.y = ty + 30;
    doc.x = 50;
    doc.font("Helvetica").fillColor(MUTED).fontSize(7.5).text(
      "Payment processed by Razorpay. Tax treatment (GST rate, place of supply, SAC code and GSTIN details) must be reviewed by a qualified accountant before this document is used as a GST tax invoice.",
      { width },
    );
    doc.end();
  });
}

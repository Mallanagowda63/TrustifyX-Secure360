import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

export interface MailTransport {
  send(msg: MailMessage): Promise<void>;
}

let override: MailTransport | null = null;
let smtp: Transporter | null = null;

/** Tests inject a capturing transport here. */
export function setMailTransport(t: MailTransport | null) {
  override = t;
}

/** Returns null when SMTP is not configured; callers record the alert as SKIPPED. */
export function mailTransport(): MailTransport | null {
  if (override) return override;
  const e = env();
  if (!e.SMTP_HOST) return null;
  smtp ??= nodemailer.createTransport({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure: e.SMTP_SECURE,
    auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
    requireTLS: !e.SMTP_SECURE,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
  const t = smtp;
  return {
    async send(msg) {
      await t.sendMail({ from: e.MAIL_FROM, ...msg });
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal branded HTML wrapper around plain-text paragraphs. All content is escaped. */
export function renderEmail(title: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(p)}</p>`).join("");
  const button = cta
    ? `<p><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#0b1530;font-family:Segoe UI,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="color:#93c5fd;font-weight:600;font-size:14px;margin-bottom:12px">TrustifyX Secure360</div>
<div style="background:#ffffff;border-radius:10px;padding:24px;color:#0f172a">
<h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(title)}</h2>${body}${button}
</div>
<div style="color:#64748b;font-size:12px;margin-top:12px">You receive this because you are a member of an organization on TrustifyX Secure360. Change notification preferences in Settings.</div>
</div></body></html>`;
}

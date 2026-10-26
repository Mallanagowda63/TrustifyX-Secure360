import { Prisma, type AlertType, type NotificationPreference, type Severity } from "@prisma/client";
import { prisma } from "../db";
import { mailTransport, type MailMessage } from "./mailer";

/** "billing" goes to owners/admins regardless of preferences (account-critical). */
export type NotificationKind = "downtime" | "tls" | "findings" | "weeklyReport" | "monthlyReport" | "billing";

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

export const DEFAULT_PREFS: Omit<NotificationPreference, "id" | "orgId" | "userId"> = {
  emailDowntime: true,
  emailTlsExpiry: true,
  emailFindings: true,
  findingMinSeverity: "MEDIUM",
  emailWeeklyReport: false,
  emailMonthlyReport: true,
};

function wants(
  prefs: Omit<NotificationPreference, "id" | "orgId" | "userId">,
  kind: NotificationKind,
  severity?: Severity,
): boolean {
  switch (kind) {
    case "downtime":
      return prefs.emailDowntime;
    case "tls":
      return prefs.emailTlsExpiry;
    case "findings":
      return prefs.emailFindings && SEVERITY_RANK[severity ?? "INFO"] >= SEVERITY_RANK[prefs.findingMinSeverity];
    case "weeklyReport":
      return prefs.emailWeeklyReport;
    case "monthlyReport":
      return prefs.emailMonthlyReport;
    case "billing":
      return true;
  }
}

/** Members of the org who opted in to this kind of notification. */
export async function recipientsFor(orgId: string, kind: NotificationKind, severity?: Severity) {
  const members = await prisma.membership.findMany({
    where: { orgId, ...(kind === "billing" ? { role: { in: ["OWNER", "ADMIN"] } } : {}) },
    include: { user: { select: { id: true, email: true, notificationPrefs: { where: { orgId } } } } },
  });
  return members
    .filter((m) => wants(m.user.notificationPrefs[0] ?? DEFAULT_PREFS, kind, severity))
    .map((m) => ({ userId: m.user.id, email: m.user.email }));
}

export interface DispatchParams {
  orgId: string;
  websiteId?: string | null;
  type: AlertType;
  /** One logical event, e.g. `down:<incidentId>`. The same key is never delivered twice to a recipient. */
  dedupeKey: string;
  kind: NotificationKind;
  severity?: Severity;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailMessage["attachments"];
}

export interface DispatchResult {
  sent: number;
  skipped: number;
  failed: number;
  duplicates: number;
}

export async function dispatchAlert(p: DispatchParams): Promise<DispatchResult> {
  const result: DispatchResult = { sent: 0, skipped: 0, failed: 0, duplicates: 0 };
  const recipients = await recipientsFor(p.orgId, p.kind, p.severity);
  const transport = mailTransport();

  for (const r of recipients) {
    let alertId: string;
    try {
      // The unique (dedupeKey, recipient) constraint is the deduplication lock: if the row
      // already exists (earlier run, retry, or a concurrent worker) we do not send again.
      const row = await prisma.alert.create({
        data: {
          orgId: p.orgId,
          websiteId: p.websiteId ?? null,
          type: p.type,
          dedupeKey: p.dedupeKey,
          recipient: r.email,
          subject: p.subject.slice(0, 300),
          status: "PENDING",
        },
      });
      alertId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        result.duplicates++;
        continue;
      }
      throw err;
    }

    if (!transport) {
      await prisma.alert.update({ where: { id: alertId }, data: { status: "SKIPPED", error: "SMTP is not configured" } });
      result.skipped++;
      continue;
    }
    try {
      await transport.send({ to: r.email, subject: p.subject, text: p.text, html: p.html, attachments: p.attachments });
      await prisma.alert.update({ where: { id: alertId }, data: { status: "SENT" } });
      result.sent++;
    } catch (err) {
      await prisma.alert.update({
        where: { id: alertId },
        data: { status: "FAILED", error: (err as Error).message.slice(0, 500) },
      });
      result.failed++;
    }
  }
  return result;
}

import { marketingUrl } from "../sites";
import { renderEmail } from "../alerts/mailer";
import { dispatchAlert } from "../alerts/notify";

/** Billing emails go to organization owners and admins, once per dedupe key. */
export async function notifyBilling(orgId: string, dedupeKey: string, subject: string, lines: string[]) {
  try {
    await dispatchAlert({
      orgId,
      type: "BILLING",
      kind: "billing",
      dedupeKey: `billing:${orgId}:${dedupeKey}`,
      subject: `[Secure360] ${subject}`,
      text: lines.join("\n\n"),
      html: renderEmail(subject, lines, { label: "Open billing", url: marketingUrl("/account/billing") }),
    });
  } catch (err) {
    console.error("[billing] notification failed", (err as Error).message);
  }
}

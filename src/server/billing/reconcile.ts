import { prisma } from "../db";
import { env } from "../env";
import { billingAudit } from "./audit";
import { gatewayAvailable, providerErrorMessage } from "./gateway";
import { reconcileAllMonitoring } from "./monitoring-gate";
import { notifyBilling } from "./notify";
import { syncSubscriptionFromProvider } from "./sync";
import { processWebhookEvent } from "./webhooks";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_WEBHOOK_ATTEMPTS = 8;

/**
 * Periodic safety net (worker, every 10 min):
 *  1. retry webhook events that were stored but not processed (or failed)
 *  2. pull authoritative state from Razorpay for subscriptions that should have changed
 *     (missed webhooks): renewals due, past-due, pending checkouts
 *  3. time-based transitions for prepaid / complimentary periods and abandoned checkouts
 *  4. renewal reminders for prepaid plans
 *  5. align monitoring with entitlements for every organization
 */
export async function reconcileBilling(now = new Date()) {
  const stats = { webhooksRetried: 0, synced: 0, syncErrors: 0, expired: 0, pastDue: 0, abandoned: 0, reminders: 0, monitoring: { orgs: 0, resumed: 0, paused: 0 } };
  const e = env();

  const stuck = await prisma.paymentWebhookEvent.findMany({
    where: {
      OR: [
        { status: "RECEIVED", receivedAt: { lt: new Date(now.getTime() - 60_000) } },
        { status: "FAILED", attempts: { lt: MAX_WEBHOOK_ATTEMPTS } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: 100,
  });
  for (const ev of stuck) {
    try {
      await processWebhookEvent(ev.id);
      stats.webhooksRetried++;
    } catch {
      // recorded as FAILED with the error; retried next run
    }
  }

  if (gatewayAvailable()) {
    const due = await prisma.subscription.findMany({
      where: {
        mode: "RECURRING",
        razorpaySubscriptionId: { not: null },
        OR: [
          { status: "PENDING_PAYMENT", createdAt: { gt: new Date(now.getTime() - 3 * DAY) } },
          { status: "ACTIVE", currentPeriodEnd: { lt: new Date(now.getTime() + HOUR) } },
          { status: { in: ["PAST_DUE", "HALTED"] } },
          { status: "ACTIVE", cancelAtPeriodEnd: true },
        ],
      },
      include: { plan: true },
      take: 200,
    });
    for (const s of due) {
      try {
        await syncSubscriptionFromProvider(s, "SYSTEM");
        stats.synced++;
      } catch (err) {
        stats.syncErrors++;
        console.error("[billing] reconcile sync failed", s.id, providerErrorMessage(err));
      }
    }
  }

  const graceMs = e.BILLING_GRACE_DAYS * DAY;
  // Prepaid periods that ended → past due with grace; grace over → expired.
  const prepaidEnded = await prisma.subscription.findMany({ where: { mode: "PREPAID", status: "ACTIVE", currentPeriodEnd: { lt: now } }, include: { plan: true } });
  for (const s of prepaidEnded) {
    const cancelled = s.cancelAtPeriodEnd;
    await prisma.subscription.update({
      where: { id: s.id },
      data: cancelled ? { status: "CANCELLED", endedAt: s.currentPeriodEnd } : { status: "PAST_DUE", graceUntil: new Date(s.currentPeriodEnd!.getTime() + graceMs) },
    });
    await billingAudit({ orgId: s.orgId, actorType: "SYSTEM", action: cancelled ? "subscription.ended" : "subscription.renewal_due", subscriptionId: s.id });
    if (!cancelled) {
      stats.pastDue++;
      await notifyBilling(s.orgId, `prepaid-due:${s.id}:${s.currentPeriodEnd!.getTime()}`, "Your Secure360 plan needs renewal", [
        `Your prepaid ${s.plan.name} period ended on ${s.currentPeriodEnd!.toUTCString()}.`,
        `Monitoring continues for a ${e.BILLING_GRACE_DAYS}-day grace period. Renew under Billing to keep your websites monitored.`,
      ]);
    }
  }
  const graceOver = await prisma.subscription.findMany({ where: { mode: { in: ["PREPAID", "COMPLIMENTARY"] }, status: "PAST_DUE", graceUntil: { lt: now } } });
  for (const s of graceOver) {
    await prisma.subscription.update({ where: { id: s.id }, data: { status: "EXPIRED", endedAt: now } });
    await billingAudit({ orgId: s.orgId, actorType: "SYSTEM", action: "subscription.expired", subscriptionId: s.id });
    stats.expired++;
  }
  const compEnded = await prisma.subscription.updateMany({ where: { mode: "COMPLIMENTARY", status: "ACTIVE", currentPeriodEnd: { lt: now } }, data: { status: "EXPIRED", endedAt: now } });
  stats.expired += compEnded.count;

  const abandoned = await prisma.subscription.updateMany({
    where: {
      status: "PENDING_PAYMENT",
      paidCount: 0,
      createdAt: { lt: new Date(now.getTime() - e.BILLING_PENDING_EXPIRY_HOURS * HOUR) },
      OR: [{ scheduledStartAt: null }, { scheduledStartAt: { lt: now } }],
    },
    data: { status: "ABANDONED" },
  });
  stats.abandoned = abandoned.count;

  // Prepaid renewal reminders at 7 and 1 days before the period ends.
  for (const days of [7, 1]) {
    const soon = await prisma.subscription.findMany({
      where: { mode: "PREPAID", status: "ACTIVE", cancelAtPeriodEnd: false, currentPeriodEnd: { gt: now, lt: new Date(now.getTime() + days * DAY) } },
      include: { plan: true },
    });
    for (const s of soon) {
      await notifyBilling(s.orgId, `prepaid-reminder:${s.id}:${s.currentPeriodEnd!.getTime()}:${days}`, `Your plan renews manually in ${days} day(s)`, [
        `Your prepaid ${s.plan.name} period ends on ${s.currentPeriodEnd!.toUTCString()}. Prepaid plans do not renew automatically.`,
        "Renew under Billing to continue uninterrupted monitoring.",
      ]);
      stats.reminders++;
    }
  }

  stats.monitoring = await reconcileAllMonitoring();
  return stats;
}

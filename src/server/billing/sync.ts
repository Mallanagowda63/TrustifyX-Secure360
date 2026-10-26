import type { BillingCycle, PaymentStatus, PricingPlan, Subscription, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { billingAudit, type BillingActor } from "./audit";
import { billingGateway, providerErrorMessage, type ProviderPayment, type ProviderSubscription } from "./gateway";
import { reconcileOrgMonitoring } from "./monitoring-gate";
import { notifyBilling } from "./notify";
import { formatInr } from "./plans";

const DAY = 86_400_000;
const fromUnix = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);

export function addCycle(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (cycle === "ANNUAL" ? 12 : 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

const PROVIDER_STATUS: Record<string, SubscriptionStatus> = {
  created: "PENDING_PAYMENT",
  authenticated: "PENDING_PAYMENT",
  active: "ACTIVE",
  pending: "PAST_DUE",
  halted: "HALTED",
  paused: "HALTED",
  cancelled: "CANCELLED",
  completed: "COMPLETED",
  expired: "EXPIRED",
};

type SubWithPlan = Subscription & { plan: PricingPlan };

/**
 * Applies the provider's authoritative subscription entity to our record. Because callers pass
 * the latest entity fetched from Razorpay, duplicate and out-of-order webhooks converge to the
 * same state. A subscription is ACTIVE only once Razorpay reports it active with at least one
 * collected charge.
 */
export async function applyProviderSubscription(local: SubWithPlan, entity: ProviderSubscription, actor: BillingActor) {
  if (entity.id !== local.razorpaySubscriptionId) throw new Error("Provider subscription id mismatch");
  const graceMs = env().BILLING_GRACE_DAYS * DAY;
  let status = PROVIDER_STATUS[entity.status] ?? local.status;
  const paidCount = Math.max(local.paidCount, entity.paid_count ?? 0);
  if (status === "ACTIVE" && paidCount < 1) status = "PENDING_PAYMENT";

  const periodStart = fromUnix(entity.current_start) ?? local.currentPeriodStart;
  let periodEnd = fromUnix(entity.current_end) ?? local.currentPeriodEnd;
  const endedAt = fromUnix(entity.ended_at);
  if ((status === "CANCELLED" || status === "COMPLETED") && endedAt && (!periodEnd || endedAt < periodEnd)) periodEnd = endedAt;

  let graceUntil: Date | null = null;
  if (status === "PAST_DUE" || status === "HALTED") {
    graceUntil = local.graceUntil ?? new Date((periodEnd ?? new Date()).getTime() + graceMs);
    if (entity.status === "paused") graceUntil = new Date();
  }

  const updated = await prisma.subscription.update({
    where: { id: local.id },
    data: {
      status,
      providerStatus: entity.status,
      paidCount,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      graceUntil,
      endedAt: endedAt ?? local.endedAt,
      cancelledAt: status === "CANCELLED" ? (local.cancelledAt ?? new Date()) : local.cancelledAt,
      lastSyncedAt: new Date(),
    },
    include: { plan: true },
  });

  if (local.status !== updated.status) {
    await billingAudit({
      orgId: local.orgId,
      actorType: actor,
      action: "subscription.status_changed",
      subscriptionId: local.id,
      details: { from: local.status, to: updated.status, providerStatus: entity.status, paidCount },
    });
    await onStatusChange(local, updated);
  }

  // Scheduled downgrade: once the customer authorised the new subscription, stop the old one renewing.
  if (updated.replacesSubscriptionId && updated.scheduledStartAt && (entity.status === "authenticated" || updated.status === "ACTIVE")) {
    await retireReplaced(updated, "cycle_end", actor);
  }
  // Upgrade: once the new plan is paid and active, end the old subscription now.
  if (updated.replacesSubscriptionId && !updated.scheduledStartAt && updated.status === "ACTIVE") {
    await retireReplaced(updated, "now", actor);
  }

  await ensureInvoices(updated.id, { start: updated.currentPeriodStart, end: updated.currentPeriodEnd });
  await reconcileOrgMonitoring(local.orgId);
  return updated;
}

/** Back-fills receipts for captured payments of a subscription (covers missed charge webhooks). */
async function ensureInvoices(subscriptionId: string, period: { start: Date | null; end: Date | null }) {
  const missing = await prisma.payment.findMany({ where: { subscriptionId, status: "CAPTURED", invoice: null } });
  for (const p of missing) await issueInvoice(p.id, period);
}

async function retireReplaced(newSub: Subscription, when: "now" | "cycle_end", actor: BillingActor) {
  const old = await prisma.subscription.findUnique({ where: { id: newSub.replacesSubscriptionId! } });
  if (!old || old.orgId !== newSub.orgId) return;
  if (when === "cycle_end" && old.cancelAtPeriodEnd) return;
  if (when === "now" && (old.status === "CANCELLED" || old.status === "EXPIRED" || old.status === "COMPLETED")) return;

  if (old.mode === "RECURRING" && old.razorpaySubscriptionId && (old.status === "ACTIVE" || old.status === "PAST_DUE" || old.status === "HALTED")) {
    try {
      await billingGateway().cancelSubscription(old.razorpaySubscriptionId, when === "cycle_end");
    } catch (err) {
      await billingAudit({ orgId: old.orgId, actorType: actor, action: "subscription.retire_failed", subscriptionId: old.id, details: { error: providerErrorMessage(err) } });
      return;
    }
  }
  const now = new Date();
  await prisma.subscription.update({
    where: { id: old.id },
    data:
      when === "now"
        ? { status: "CANCELLED", cancelledAt: now, endedAt: now, currentPeriodEnd: now, cancelAtPeriodEnd: false }
        : { cancelAtPeriodEnd: true, cancelledAt: now },
  });
  await billingAudit({
    orgId: old.orgId,
    actorType: actor,
    action: when === "now" ? "subscription.replaced_now" : "subscription.replaced_at_cycle_end",
    subscriptionId: old.id,
    details: { replacedBy: newSub.id },
  });
}

async function onStatusChange(before: Subscription, after: SubWithPlan) {
  const plan = after.plan;
  if (after.status === "ACTIVE" && before.status === "PENDING_PAYMENT") {
    await notifyBilling(after.orgId, `sub-active:${after.id}`, `Your ${plan.name} subscription is active`, [
      `Thank you. Your TrustifyX Secure360 ${plan.name} subscription is now active.`,
      "Next step: add your website and verify domain ownership under Websites. Monitoring starts automatically once ownership is verified.",
    ]);
  } else if (after.status === "PAST_DUE" || after.status === "HALTED") {
    await notifyBilling(after.orgId, `sub-pastdue:${after.id}:${after.currentPeriodEnd?.getTime() ?? 0}`, "Payment for your subscription failed", [
      `We could not collect the renewal payment for your ${plan.name} subscription.`,
      `Monitoring continues until ${after.graceUntil?.toUTCString() ?? "the end of the grace period"}. Update your payment method or renew under Billing to avoid interruption.`,
    ]);
  } else if (after.status === "CANCELLED" && before.status !== "CANCELLED") {
    await notifyBilling(after.orgId, `sub-cancelled:${after.id}`, "Your subscription was cancelled", [
      `Your ${plan.name} subscription is cancelled. Service remains available until ${after.currentPeriodEnd?.toUTCString() ?? "now"}.`,
      "Your websites, findings and reports are kept according to our retention policy; resubscribe any time to resume monitoring.",
    ]);
  }
}

/** Fetches the latest subscription state from Razorpay and applies it. */
export async function syncSubscriptionFromProvider(local: SubWithPlan, actor: BillingActor) {
  if (local.mode !== "RECURRING" || !local.razorpaySubscriptionId) return local;
  const entity = await billingGateway().fetchSubscription(local.razorpaySubscriptionId);
  return applyProviderSubscription(local, entity, actor);
}

// ─── Payments & invoices ───

const PAYMENT_RANK: Record<PaymentStatus, number> = {
  CREATED: 0,
  FAILED: 1,
  AUTHORIZED: 2,
  CAPTURED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
};

function paymentStatusOf(p: ProviderPayment): PaymentStatus {
  const refunded = p.amount_refunded ?? 0;
  if (refunded > 0) return refunded >= p.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
  switch (p.status) {
    case "captured":
      return "CAPTURED";
    case "authorized":
      return "AUTHORIZED";
    case "failed":
      return "FAILED";
    case "refunded":
      return "REFUNDED";
    default:
      return "CREATED";
  }
}

export interface RecordedPayment {
  paymentId: string;
  status: PaymentStatus;
  newlyCaptured: boolean;
  newlyFailed: boolean;
  newlyRefunded: boolean;
}

/**
 * Idempotently records a provider payment. Status only moves forward; the transition into
 * CAPTURED is claimed with a conditional update so concurrent webhook/verify paths cannot
 * both treat the same payment as new (which would double-extend a prepaid period).
 */
export async function recordProviderPayment(
  p: ProviderPayment,
  ctx: { orgId: string; subscriptionId: string | null },
  actor: BillingActor,
): Promise<RecordedPayment> {
  const status = paymentStatusOf(p);
  const base = {
    amountPaise: p.amount,
    currency: p.currency,
    razorpayOrderId: p.order_id ?? null,
    razorpayInvoiceId: p.invoice_id ?? null,
    method: p.method ?? null,
  };
  const existing = await prisma.payment.findUnique({ where: { razorpayPaymentId: p.id } });
  if (existing && existing.orgId !== ctx.orgId) throw new Error("Payment belongs to another organization");
  if (!existing) {
    try {
      await prisma.payment.create({
        data: { ...base, orgId: ctx.orgId, subscriptionId: ctx.subscriptionId, razorpayPaymentId: p.id, status: "CREATED" },
      });
    } catch {
      // created concurrently; fall through to the conditional update
    }
  }
  const current = await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId: p.id } });
  const result: RecordedPayment = { paymentId: current.id, status: current.status, newlyCaptured: false, newlyFailed: false, newlyRefunded: false };

  const moveForward = PAYMENT_RANK[status] > PAYMENT_RANK[current.status] && !(status === "FAILED" && PAYMENT_RANK[current.status] >= PAYMENT_RANK.AUTHORIZED);
  if (moveForward) {
    const claimed = await prisma.payment.updateMany({
      where: { id: current.id, status: current.status },
      data: {
        ...base,
        subscriptionId: current.subscriptionId ?? ctx.subscriptionId,
        status,
        errorCode: p.error_code ?? null,
        errorDescription: p.error_description?.slice(0, 300) ?? null,
        refundedPaise: p.amount_refunded ?? current.refundedPaise,
        ...(status === "CAPTURED" ? { capturedAt: new Date() } : {}),
        ...(status === "FAILED" ? { failedAt: new Date() } : {}),
      },
    });
    if (claimed.count === 1) {
      result.status = status;
      // A payment first seen already refunded never grants service.
      result.newlyCaptured = status === "CAPTURED";
      result.newlyFailed = status === "FAILED";
      result.newlyRefunded = status === "REFUNDED" || status === "PARTIALLY_REFUNDED";
      await billingAudit({
        orgId: ctx.orgId,
        actorType: actor,
        action: `payment.${status.toLowerCase()}`,
        subscriptionId: current.subscriptionId ?? ctx.subscriptionId,
        paymentId: current.id,
        details: { razorpayPaymentId: p.id, amount: p.amount, method: p.method ?? null, error: p.error_description ?? null },
      });
    }
  } else if (status === current.status && (p.amount_refunded ?? 0) > current.refundedPaise) {
    await prisma.payment.update({ where: { id: current.id }, data: { refundedPaise: p.amount_refunded } });
    result.newlyRefunded = true;
  }
  return result;
}

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `invoice-${year}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await prisma.billingCounter.upsert({ where: { key }, create: { key, value: 1 }, update: { value: { increment: 1 } } });
      return `TXS-${year}-${String(row.value).padStart(6, "0")}`;
    } catch {
      // concurrent first insert; retry
    }
  }
  throw new Error("Could not allocate invoice number");
}

/** Creates the invoice/receipt for a captured payment exactly once. */
export async function issueInvoice(paymentId: string, period: { start: Date | null; end: Date | null }) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { invoice: true, org: true } });
  if (payment.invoice || !payment.subscriptionId) return payment.invoice;
  const rate = env().BILLING_TAX_RATE_BP;
  const subtotal = Math.round((payment.amountPaise * 10_000) / (10_000 + rate));
  const owner = await prisma.membership.findFirst({ where: { orgId: payment.orgId, role: "OWNER" }, include: { user: true }, orderBy: { createdAt: "asc" } });
  try {
    return await prisma.invoice.create({
      data: {
        orgId: payment.orgId,
        subscriptionId: payment.subscriptionId,
        paymentId: payment.id,
        number: await nextInvoiceNumber(),
        subtotalPaise: subtotal,
        taxPaise: payment.amountPaise - subtotal,
        totalPaise: payment.amountPaise,
        taxRateBp: rate,
        currency: payment.currency,
        periodStart: period.start,
        periodEnd: period.end,
        billedTo: { organization: payment.org.name, email: owner?.user.email ?? null, name: owner?.user.name ?? null },
      },
    });
  } catch {
    return prisma.invoice.findUnique({ where: { paymentId: payment.id } });
  }
}

/** Prepaid mode: a captured order payment buys one more period (from the later of now or the current end). */
export async function applyPrepaidPayment(local: SubWithPlan, recorded: RecordedPayment, actor: BillingActor) {
  if (!recorded.newlyCaptured) return local;
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: recorded.paymentId } });
  if (payment.amountPaise !== local.amountPaise || payment.currency !== local.currency) {
    await billingAudit({ orgId: local.orgId, actorType: actor, action: "payment.amount_mismatch", subscriptionId: local.id, paymentId: payment.id, details: { expected: local.amountPaise, got: payment.amountPaise } });
    return local;
  }
  const now = new Date();
  const continuing = local.currentPeriodEnd && local.currentPeriodEnd > now && (local.status === "ACTIVE" || local.status === "PAST_DUE");
  const start = local.scheduledStartAt && local.scheduledStartAt > now ? local.scheduledStartAt : continuing ? local.currentPeriodEnd! : now;
  const end = addCycle(start, local.cycle);
  const updated = await prisma.subscription.update({
    where: { id: local.id },
    data: {
      status: "ACTIVE",
      paidCount: { increment: 1 },
      currentPeriodStart: local.paidCount === 0 || !continuing ? start : local.currentPeriodStart,
      currentPeriodEnd: end,
      graceUntil: null,
      razorpayOrderId: null,
      lastSyncedAt: now,
    },
    include: { plan: true },
  });
  await issueInvoice(payment.id, { start, end });
  await billingAudit({ orgId: local.orgId, actorType: actor, action: "subscription.prepaid_period_applied", subscriptionId: local.id, paymentId: payment.id, details: { start: start.toISOString(), end: end.toISOString() } });
  if (local.status !== "ACTIVE") await onStatusChange(local, updated);
  if (updated.replacesSubscriptionId && !updated.scheduledStartAt) await retireReplaced(updated, "now", actor);
  await reconcileOrgMonitoring(local.orgId);
  return updated;
}

/**
 * Full refund of the payment funding the current period ends that period now (documented in
 * the refund policy); partial refunds keep service. Recurring subscriptions are cancelled at
 * the provider so they do not renew.
 */
export async function handleRefund(paymentId: string, actor: BillingActor) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { subscription: { include: { plan: true } }, invoice: true } });
  if (payment.status !== "REFUNDED") return;
  if (payment.invoice && payment.invoice.status !== "VOID") await prisma.invoice.update({ where: { id: payment.invoice.id }, data: { status: "VOID" } });
  const sub = payment.subscription;
  if (!sub) return;
  const latestCaptured = await prisma.payment.findFirst({ where: { subscriptionId: sub.id, capturedAt: { not: null } }, orderBy: { capturedAt: "desc" } });
  if (latestCaptured?.id !== payment.id) return;
  const now = new Date();
  if (sub.mode === "RECURRING" && sub.razorpaySubscriptionId && ["ACTIVE", "PAST_DUE", "HALTED"].includes(sub.status)) {
    try {
      await billingGateway().cancelSubscription(sub.razorpaySubscriptionId, false);
    } catch (err) {
      await billingAudit({ orgId: sub.orgId, actorType: actor, action: "subscription.cancel_after_refund_failed", subscriptionId: sub.id, details: { error: providerErrorMessage(err) } });
    }
  }
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELLED", cancelledAt: now, endedAt: now, currentPeriodEnd: now, cancelAtPeriodEnd: false },
  });
  await billingAudit({ orgId: sub.orgId, actorType: actor, action: "subscription.ended_by_refund", subscriptionId: sub.id, paymentId: payment.id });
  await notifyBilling(sub.orgId, `refund:${payment.id}`, "Refund processed", [
    `A refund of ${formatInr(payment.refundedPaise)} was processed for your ${sub.plan.name} subscription. The subscription has ended and monitoring is paused.`,
  ]);
  await reconcileOrgMonitoring(sub.orgId);
}

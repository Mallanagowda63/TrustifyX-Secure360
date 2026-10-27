import type { BillingCycle, PricingPlan, Subscription } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { ApiError } from "../api";
import { assertCan, type Actor } from "../services/actor";
import { billingAudit } from "./audit";
import { accessUntil, getEntitlement } from "./entitlements";
import {
  billingGateway,
  BillingNotConfiguredError,
  gatewayAvailable,
  isTestMode,
  providerErrorMessage,
} from "./gateway";
import { annualEnabled, getPlanByCode, listPlans, planRank, presentPlan, priceFor } from "./plans";
import { verifyOrderPaymentSignature, verifySubscriptionPaymentSignature } from "./signatures";
import { applyPrepaidPayment, applyProviderSubscription, recordProviderPayment, syncSubscriptionFromProvider } from "./sync";
import { reconcileOrgMonitoring } from "./monitoring-gate";

const OPEN_STATUSES = ["ACTIVE", "PAST_DUE", "HALTED"] as const;

function billingMode(): "RECURRING" | "PREPAID" {
  return env().BILLING_MODE === "prepaid" ? "PREPAID" : "RECURRING";
}

function requireGateway() {
  if (!gatewayAvailable()) throw new ApiError(503, new BillingNotConfiguredError().message, "billing_not_configured");
}

async function resolvePlan(code: string, cycle: BillingCycle, kind: "BASE" | "ADDON" = "BASE") {
  const plan = await getPlanByCode(code);
  if (!plan || !plan.active) throw new ApiError(400, "Unknown or unavailable plan", "invalid_plan");
  // Add-ons are bought on top of a base plan through their own checkout (never as the base plan).
  if (plan.kind !== kind) throw new ApiError(400, kind === "BASE" ? "This is an add-on. Choose a base plan first." : "Unknown add-on", "invalid_plan");
  if (cycle === "ANNUAL" && !annualEnabled(plan)) throw new ApiError(400, "Annual billing is not available for this plan", "invalid_cycle");
  return plan;
}

/** Finds or creates the immutable Razorpay plan for this exact price. */
async function ensureProviderPlan(plan: PricingPlan, cycle: BillingCycle, amountPaise: number) {
  const existing = await prisma.providerPlan.findUnique({ where: { planId_cycle_amountPaise: { planId: plan.id, cycle, amountPaise } } });
  if (existing) return existing.razorpayPlanId;
  const created = await billingGateway().createPlan({
    period: cycle === "ANNUAL" ? "yearly" : "monthly",
    amountPaise,
    currency: plan.currency,
    name: `Secure360 ${plan.name} (${cycle === "ANNUAL" ? "annual" : "monthly"})`,
    description: plan.tagline,
    notes: { planCode: plan.code, cycle },
  });
  try {
    await prisma.providerPlan.create({ data: { planId: plan.id, cycle, amountPaise, razorpayPlanId: created.id } });
  } catch {
    const raced = await prisma.providerPlan.findUnique({ where: { planId_cycle_amountPaise: { planId: plan.id, cycle, amountPaise } } });
    if (raced) return raced.razorpayPlanId;
    throw new ApiError(500, "Could not register plan with payment provider");
  }
  return created.id;
}

export interface CheckoutPayload {
  mode: "RECURRING" | "PREPAID";
  keyId: string;
  subscriptionId?: string;
  orderId?: string;
  amountPaise: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  localSubscriptionId: string;
  testMode: boolean;
}

async function createProviderCheckout(
  actor: Actor,
  plan: PricingPlan,
  cycle: BillingCycle,
  opts: { replaces?: Subscription | null; startAt?: Date | null } = {},
): Promise<CheckoutPayload> {
  requireGateway();
  const price = priceFor(plan, cycle);
  const mode = billingMode();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true, email: true } });

  // Older unpaid checkouts are superseded; only one pending checkout per org at a time.
  await prisma.subscription.updateMany({
    where: { orgId: actor.orgId, status: "PENDING_PAYMENT", paidCount: 0 },
    data: { status: "ABANDONED" },
  });

  const local = await prisma.subscription.create({
    data: {
      orgId: actor.orgId,
      planId: plan.id,
      cycle,
      mode,
      status: "PENDING_PAYMENT",
      amountPaise: price.totalPaise,
      currency: price.currency,
      createdById: actor.userId,
      replacesSubscriptionId: opts.replaces?.id ?? null,
      scheduledStartAt: opts.startAt ?? null,
    },
  });
  const notes = { orgId: actor.orgId, subscriptionId: local.id, planCode: plan.code, cycle };

  try {
    if (mode === "RECURRING") {
      const razorpayPlanId = await ensureProviderPlan(plan, cycle, price.totalPaise);
      const sub = await billingGateway().createSubscription({
        planId: razorpayPlanId,
        totalCount: cycle === "ANNUAL" ? 10 : 120,
        startAt: opts.startAt ? Math.floor(opts.startAt.getTime() / 1000) : undefined,
        notes,
      });
      await prisma.subscription.update({
        where: { id: local.id },
        data: { razorpaySubscriptionId: sub.id, razorpayPlanId, providerStatus: sub.status },
      });
      await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "checkout.created", subscriptionId: local.id, details: { plan: plan.code, cycle, amountPaise: price.totalPaise, mode, providerSubscriptionId: sub.id } });
      return {
        mode,
        keyId: env().RAZORPAY_KEY_ID ?? "",
        subscriptionId: sub.id,
        amountPaise: price.totalPaise,
        currency: price.currency,
        name: "TrustifyX Secure360",
        description: `${plan.name} plan · ${cycle === "ANNUAL" ? "billed yearly" : "billed monthly"}`,
        prefill: { name: user.name, email: user.email },
        localSubscriptionId: local.id,
        testMode: isTestMode(),
      };
    }
    const order = await billingGateway().createOrder({ amountPaise: price.totalPaise, currency: price.currency, receipt: local.id, notes });
    await prisma.subscription.update({ where: { id: local.id }, data: { razorpayOrderId: order.id, providerStatus: order.status } });
    await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "checkout.created", subscriptionId: local.id, details: { plan: plan.code, cycle, amountPaise: price.totalPaise, mode, orderId: order.id } });
    return {
      mode,
      keyId: env().RAZORPAY_KEY_ID ?? "",
      orderId: order.id,
      amountPaise: price.totalPaise,
      currency: price.currency,
      name: "TrustifyX Secure360",
      description: `${plan.name} plan · ${cycle === "ANNUAL" ? "12 months (prepaid)" : "1 month (prepaid)"}`,
      prefill: { name: user.name, email: user.email },
      localSubscriptionId: local.id,
      testMode: isTestMode(),
    };
  } catch (err) {
    await prisma.subscription.update({ where: { id: local.id }, data: { status: "ABANDONED" } });
    if (err instanceof ApiError) throw err;
    await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "checkout.provider_error", subscriptionId: local.id, details: { error: providerErrorMessage(err) } });
    throw new ApiError(502, "The payment provider could not start checkout. Please try again.", "provider_error");
  }
}

/** New subscription for an organization without an active paid plan. */
export async function startCheckout(actor: Actor, input: { planCode: string; cycle: BillingCycle }) {
  assertCan(actor, "billing.manage");
  const plan = await resolvePlan(input.planCode, input.cycle);
  const ent = await getEntitlement(actor.orgId);
  if (ent.active && ent.subscription && ent.subscription.mode !== "COMPLIMENTARY" && ent.state !== "CANCELLING" && ent.state !== "GRACE") {
    throw new ApiError(409, "You already have an active subscription. Use Change plan instead.", "already_subscribed");
  }
  // Prepaid renewal (or renewal during grace) extends the existing record instead of starting a new one.
  const sub = ent.subscription;
  if (sub && sub.mode === "PREPAID" && sub.planId === plan.id && sub.cycle === input.cycle && billingMode() === "PREPAID") {
    return renewPrepaid(actor, sub, plan);
  }
  return createProviderCheckout(actor, plan, input.cycle);
}

async function renewPrepaid(actor: Actor, sub: Subscription, plan: PricingPlan): Promise<CheckoutPayload> {
  requireGateway();
  const price = priceFor(plan, sub.cycle);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true, email: true } });
  const order = await billingGateway().createOrder({
    amountPaise: price.totalPaise,
    currency: price.currency,
    receipt: `${sub.id}-r${sub.paidCount + 1}`,
    notes: { orgId: actor.orgId, subscriptionId: sub.id, planCode: plan.code, cycle: sub.cycle, renewal: "true" },
  });
  await prisma.subscription.update({ where: { id: sub.id }, data: { razorpayOrderId: order.id, amountPaise: price.totalPaise } });
  await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "checkout.renewal_created", subscriptionId: sub.id, details: { orderId: order.id, amountPaise: price.totalPaise } });
  return {
    mode: "PREPAID",
    keyId: env().RAZORPAY_KEY_ID ?? "",
    orderId: order.id,
    amountPaise: price.totalPaise,
    currency: price.currency,
    name: "TrustifyX Secure360",
    description: `Renew ${plan.name} plan`,
    prefill: { name: user.name, email: user.email },
    localSubscriptionId: sub.id,
    testMode: isTestMode(),
  };
}

export async function renewSubscription(actor: Actor) {
  assertCan(actor, "billing.manage");
  const ent = await getEntitlement(actor.orgId);
  const latest =
    ent.subscription ??
    (await prisma.subscription.findFirst({ where: { orgId: actor.orgId, status: { in: ["EXPIRED", "PAST_DUE", "HALTED", "CANCELLED", "COMPLETED"] }, mode: { not: "COMPLIMENTARY" } }, include: { plan: true }, orderBy: { updatedAt: "desc" } }));
  if (!latest) throw new ApiError(400, "There is no subscription to renew. Choose a plan instead.");
  if (latest.mode === "PREPAID") return renewPrepaid(actor, latest, latest.plan);
  if (ent.active && ent.state === "ACTIVE") throw new ApiError(409, "Your subscription renews automatically.");
  // Recurring subscriptions that ended cannot be restarted at Razorpay; start a fresh one on the same plan.
  return createProviderCheckout(actor, latest.plan, latest.cycle);
}

/** Upgrade: new plan starts now, old one ends when the new payment is confirmed. Downgrade: from the next period. */
export async function changePlan(actor: Actor, input: { planCode: string; cycle: BillingCycle }) {
  assertCan(actor, "billing.manage");
  const plan = await resolvePlan(input.planCode, input.cycle);
  const ent = await getEntitlement(actor.orgId);
  const current = ent.subscription;
  if (!ent.active || !current || current.mode === "COMPLIMENTARY") return startCheckout(actor, input);
  if (current.planId === plan.id && current.cycle === input.cycle) throw new ApiError(400, "You are already on this plan.");

  const newMonthly = priceFor(plan, input.cycle).totalPaise / (input.cycle === "ANNUAL" ? 12 : 1);
  const oldMonthly = current.amountPaise / (current.cycle === "ANNUAL" ? 12 : 1);
  const upgrade = planRank(plan) > planRank(current.plan) || (planRank(plan) === planRank(current.plan) && newMonthly >= oldMonthly);

  if (!upgrade) {
    const usedSites = await prisma.website.count({ where: { orgId: actor.orgId } });
    const startAt = current.currentPeriodEnd && current.currentPeriodEnd > new Date() ? current.currentPeriodEnd : null;
    await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "plan_change.downgrade_requested", subscriptionId: current.id, details: { to: plan.code, cycle: input.cycle, startAt: startAt?.toISOString() ?? null, websitesInUse: usedSites, newLimit: plan.maxWebsites } });
    return createProviderCheckout(actor, plan, input.cycle, { replaces: current, startAt });
  }
  await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "plan_change.upgrade_requested", subscriptionId: current.id, details: { to: plan.code, cycle: input.cycle } });
  return createProviderCheckout(actor, plan, input.cycle, { replaces: current });
}

/**
 * Confirms a checkout. The signature proves the browser response came from Razorpay, but
 * activation additionally requires the provider's authoritative state (subscription fetched
 * as active / payment captured). Webhooks reach the same state independently.
 */
export async function verifyCheckout(
  actor: Actor,
  input: { razorpay_payment_id: string; razorpay_signature: string; razorpay_subscription_id?: string; razorpay_order_id?: string },
) {
  assertCan(actor, "billing.manage");
  requireGateway();
  const secret = env().RAZORPAY_KEY_SECRET ?? "";
  let local;
  if (input.razorpay_subscription_id) {
    local = await prisma.subscription.findFirst({ where: { orgId: actor.orgId, razorpaySubscriptionId: input.razorpay_subscription_id }, include: { plan: true } });
    if (!local) throw new ApiError(404, "Checkout not found", "not_found");
    const ok = verifySubscriptionPaymentSignature({ paymentId: input.razorpay_payment_id, subscriptionId: local.razorpaySubscriptionId!, signature: input.razorpay_signature, keySecret: secret });
    if (!ok) {
      await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "checkout.signature_invalid", subscriptionId: local.id, details: { paymentId: input.razorpay_payment_id.slice(0, 40) } });
      throw new ApiError(400, "Payment verification failed", "invalid_signature");
    }
    try {
      const payment = await billingGateway().fetchPayment(input.razorpay_payment_id);
      await recordProviderPayment(payment, { orgId: actor.orgId, subscriptionId: local.id }, "USER");
    } catch {
      // payment details also arrive via subscription.charged; state below is what matters
    }
    local = await syncSubscriptionFromProvider(local, "USER");
  } else if (input.razorpay_order_id) {
    local = await prisma.subscription.findFirst({ where: { orgId: actor.orgId, razorpayOrderId: input.razorpay_order_id }, include: { plan: true } });
    if (!local) {
      const paid = await prisma.payment.findFirst({ where: { orgId: actor.orgId, razorpayPaymentId: input.razorpay_payment_id, razorpayOrderId: input.razorpay_order_id } });
      if (paid) return billingOverview(actor.orgId); // already processed (e.g. by webhook)
      throw new ApiError(404, "Checkout not found", "not_found");
    }
    const ok = verifyOrderPaymentSignature({ orderId: local.razorpayOrderId!, paymentId: input.razorpay_payment_id, signature: input.razorpay_signature, keySecret: secret });
    if (!ok) {
      await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: "checkout.signature_invalid", subscriptionId: local.id });
      throw new ApiError(400, "Payment verification failed", "invalid_signature");
    }
    let payment = await billingGateway().fetchPayment(input.razorpay_payment_id);
    if (payment.order_id !== local.razorpayOrderId) throw new ApiError(400, "Payment does not belong to this checkout", "payment_mismatch");
    if (payment.status === "authorized") payment = await billingGateway().capturePayment(payment.id, payment.amount, payment.currency);
    const recorded = await recordProviderPayment(payment, { orgId: actor.orgId, subscriptionId: local.id }, "USER");
    local = await applyPrepaidPayment(local, recorded, "USER");
  } else {
    throw new ApiError(400, "Missing checkout reference");
  }
  await reconcileOrgMonitoring(actor.orgId);
  return billingOverview(actor.orgId);
}

export async function cancelSubscription(actor: Actor, input: { atPeriodEnd: boolean }) {
  assertCan(actor, "billing.manage");
  const ent = await getEntitlement(actor.orgId);
  const sub = ent.subscription;
  if (!ent.active || !sub) throw new ApiError(400, "There is no active subscription to cancel.");
  return cancelOne(actor, sub, input.atPeriodEnd);
}

async function cancelOne(actor: Actor, sub: Subscription & { plan: PricingPlan }, atPeriodEnd: boolean) {
  const input = { atPeriodEnd };
  if (sub.mode === "COMPLIMENTARY") throw new ApiError(400, "Complimentary access is managed by TrustifyX support.");
  const now = new Date();

  if (sub.mode === "RECURRING" && sub.razorpaySubscriptionId) {
    requireGateway();
    try {
      const entity = await billingGateway().cancelSubscription(sub.razorpaySubscriptionId, input.atPeriodEnd);
      await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: input.atPeriodEnd, cancelledAt: now } });
      const fresh = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } });
      await applyProviderSubscription(fresh, entity, "USER");
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(502, `Cancellation failed at the payment provider: ${providerErrorMessage(err)}`, "provider_error");
    }
  } else {
    // Prepaid never auto-renews; immediate cancellation ends access now (no pro-rata refund).
    await prisma.subscription.update({
      where: { id: sub.id },
      data: input.atPeriodEnd
        ? { cancelAtPeriodEnd: true, cancelledAt: now }
        : { status: "CANCELLED", cancelledAt: now, endedAt: now, currentPeriodEnd: now },
    });
  }
  // Pending replacement checkouts are abandoned too.
  await prisma.subscription.updateMany({ where: { orgId: actor.orgId, status: "PENDING_PAYMENT", replacesSubscriptionId: sub.id }, data: { status: "ABANDONED" } });
  await billingAudit({ orgId: actor.orgId, actorType: "USER", actorUserId: actor.userId, action: input.atPeriodEnd ? "subscription.cancel_at_period_end" : "subscription.cancel_now", subscriptionId: sub.id });
  await reconcileOrgMonitoring(actor.orgId);
  return billingOverview(actor.orgId);
}

// ─────────────────────────────── add-ons (e.g. Secure360 Protect) ───────────────────────────────

/** Buys an add-on on top of an active base plan, through the same verified Razorpay flow. */
export async function startAddonCheckout(actor: Actor, input: { addonCode: string; cycle: BillingCycle }) {
  assertCan(actor, "billing.manage");
  const plan = await resolvePlan(input.addonCode, input.cycle, "ADDON");
  const base = await getEntitlement(actor.orgId);
  if (!base.active) throw new ApiError(402, "Add-ons require an active Starter, Growth or Business plan.", "subscription_required");
  const current = await activeAddonSubscription(actor.orgId, plan.code);
  if (current && !current.cancelAtPeriodEnd && current.mode !== "COMPLIMENTARY") throw new ApiError(409, `${plan.name} is already active.`, "already_subscribed");
  return createProviderCheckout(actor, plan, input.cycle);
}

async function activeAddonSubscription(orgId: string, code: string) {
  const now = new Date();
  const subs = await prisma.subscription.findMany({
    where: { orgId, plan: { code, kind: "ADDON" }, status: { in: [...OPEN_STATUSES, "CANCELLED", "COMPLETED"] } },
    include: { plan: true },
    orderBy: { currentPeriodEnd: "desc" },
  });
  return subs.find((s) => {
    const until = accessUntil(s);
    return until !== null && until > now && (!s.currentPeriodStart || s.currentPeriodStart <= now);
  }) ?? null;
}

/** Cancels only the add-on; the base plan is untouched. */
export async function cancelAddon(actor: Actor, input: { addonCode: string; atPeriodEnd: boolean }) {
  assertCan(actor, "billing.manage");
  const sub = await activeAddonSubscription(actor.orgId, input.addonCode);
  if (!sub) throw new ApiError(400, "This add-on is not active.", "not_active");
  return cancelOne(actor, sub, input.atPeriodEnd);
}

/** Pulls the latest state for this org's open recurring subscriptions from Razorpay. */
export async function syncOrgBilling(actor: Actor) {
  assertCan(actor, "billing.manage");
  requireGateway();
  const subs = await prisma.subscription.findMany({
    where: { orgId: actor.orgId, mode: "RECURRING", razorpaySubscriptionId: { not: null }, status: { in: ["PENDING_PAYMENT", ...OPEN_STATUSES] } },
    include: { plan: true },
  });
  for (const s of subs) {
    try {
      await syncSubscriptionFromProvider(s, "USER");
    } catch (err) {
      console.error("[billing] sync failed", s.id, providerErrorMessage(err));
    }
  }
  await reconcileOrgMonitoring(actor.orgId);
  return billingOverview(actor.orgId);
}

export async function billingOverview(orgId: string) {
  const [ent, plans, addonPlans, websites, connected, members, payments, invoices, pending, history] = await Promise.all([
    getEntitlement(orgId),
    listPlans(),
    listPlans(false, "ADDON"),
    prisma.website.count({ where: { orgId } }),
    prisma.website.count({ where: { orgId, status: "CONNECTED" } }),
    prisma.membership.count({ where: { orgId } }),
    prisma.payment.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, razorpayPaymentId: true, amountPaise: true, currency: true, status: true, method: true, errorDescription: true, refundedPaise: true, createdAt: true, capturedAt: true },
    }),
    prisma.invoice.findMany({
      where: { orgId },
      orderBy: { issuedAt: "desc" },
      take: 50,
      select: { id: true, number: true, totalPaise: true, taxPaise: true, currency: true, status: true, issuedAt: true, periodStart: true, periodEnd: true },
    }),
    prisma.subscription.findFirst({ where: { orgId, status: "PENDING_PAYMENT" }, include: { plan: true }, orderBy: { createdAt: "desc" } }),
    prisma.subscription.findMany({ where: { orgId, status: { not: "ABANDONED" } }, include: { plan: { select: { name: true, code: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const sub = ent.subscription;
  return {
    entitlement: {
      active: ent.active,
      state: ent.state,
      accessUntil: ent.accessUntil,
      limits: ent.limits,
      plan: ent.plan ? { code: ent.plan.code, name: ent.plan.name } : null,
    },
    subscription: sub
      ? {
          id: sub.id,
          planCode: sub.plan.code,
          planName: sub.plan.name,
          cycle: sub.cycle,
          mode: sub.mode,
          status: sub.status,
          amountPaise: sub.amountPaise,
          currency: sub.currency,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          graceUntil: sub.graceUntil,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          // Recurring renews at period end unless cancelling; prepaid requires manual renewal.
          nextBillingDate: sub.mode === "RECURRING" && !sub.cancelAtPeriodEnd && sub.status === "ACTIVE" ? sub.currentPeriodEnd : null,
          autoRenews: sub.mode === "RECURRING" && !sub.cancelAtPeriodEnd,
          grantReason: sub.mode === "COMPLIMENTARY" ? sub.grantReason : null,
        }
      : null,
    pending: pending
      ? {
          id: pending.id,
          planName: pending.plan.name,
          cycle: pending.cycle,
          scheduledStartAt: pending.scheduledStartAt,
          createdAt: pending.createdAt,
          replaces: Boolean(pending.replacesSubscriptionId),
          razorpaySubscriptionId: pending.razorpaySubscriptionId,
          razorpayOrderId: pending.razorpayOrderId,
        }
      : null,
    history: history.map((h) => ({ id: h.id, plan: h.plan.name, cycle: h.cycle, mode: h.mode, status: h.status, start: h.currentPeriodStart, end: h.currentPeriodEnd, createdAt: h.createdAt })),
    usage: { websites, connectedWebsites: connected, members },
    payments,
    invoices,
    plans: plans.map(presentPlan),
    addons: await Promise.all(
      addonPlans.map(async (p) => {
        const s = await activeAddonSubscription(orgId, p.code);
        return {
          ...presentPlan(p),
          active: Boolean(s),
          subscription: s
            ? { id: s.id, mode: s.mode, status: s.status, cycle: s.cycle, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, accessUntil: accessUntil(s), grantReason: s.mode === "COMPLIMENTARY" ? s.grantReason : null }
            : null,
        };
      }),
    ),
    config: { mode: billingMode(), configured: gatewayAvailable(), testMode: isTestMode(), annualEnabled: annualEnabled(), graceDays: env().BILLING_GRACE_DAYS },
  };
}

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { setBillingGateway } from "@/server/billing/gateway";
import { getEntitlement } from "@/server/billing/entitlements";
import { billingOverview, cancelSubscription, changePlan, renewSubscription, startCheckout, verifyCheckout } from "@/server/billing/service";
import { processWebhookEvent, receiveWebhook } from "@/server/billing/webhooks";
import { reconcileBilling } from "@/server/billing/reconcile";
import { reconcileOrgMonitoring } from "@/server/billing/monitoring-gate";
import { adminGrantComplimentary, adminRevokeComplimentary, adminUpdatePlan } from "@/server/billing/admin";
import { signForTests } from "@/server/billing/signatures";
import { createWebsite, verifyWebsite } from "@/server/services/websites";
import { runAvailabilityCheck } from "@/server/monitoring/run";
import { createSession, sessionCookieName } from "@/server/auth/session";
import { setMailTransport, type MailMessage } from "@/server/alerts/mailer";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { POST as webhookRoute } from "@/app/api/webhooks/razorpay/route";
import { GET as invoicePdfRoute } from "@/app/api/billing/invoices/[id]/pdf/route";
import { GET as adminBillingRoute } from "@/app/api/admin/billing/route";
import { FakeRazorpay, signedEvent, TEST_KEY_SECRET } from "../helpers/fake-razorpay";
import { hasTestDb, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";

const APP = "http://localhost:3000";
const up = { success: true, statusCode: 200, responseTimeMs: 50, redirectCount: 0, finalUrl: "https://x/", attempts: 1, error: null };

let rp: FakeRazorpay;
let mail: MailMessage[];

/** Unpaid owner org (no complimentary grant). */
const paidOrg = (name: string) => makeOrg(name, "OWNER", { plan: null });

/** Simulates the browser checkout handler response for a recurring subscription. */
function checkoutResponse(subId: string, paymentId: string) {
  return { razorpay_payment_id: paymentId, razorpay_subscription_id: subId, razorpay_signature: signForTests(TEST_KEY_SECRET, `${paymentId}|${subId}`) };
}

async function deliver(event: string, payload: Record<string, unknown>, eventId?: string) {
  const e = signedEvent(event, payload, eventId);
  const r = await receiveWebhook(e.raw, e.signature, e.eventId, "test");
  if (r.ok && !r.duplicate) await processWebhookEvent(r.id);
  return { ...r, eventId: e.eventId };
}

/** Full recurring purchase: checkout → provider charge → verified → ACTIVE. */
async function subscribe(actor: Awaited<ReturnType<typeof paidOrg>>["actor"], planCode = "GROWTH") {
  const co = await startCheckout(actor, { planCode, cycle: "MONTHLY" });
  const pay = rp.charge(co.subscriptionId!);
  await verifyCheckout(actor, checkoutResponse(co.subscriptionId!, pay.id));
  return { co, pay };
}

describe.skipIf(!hasTestDb)("billing: payments, subscriptions and entitlements", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    rp = new FakeRazorpay();
    setBillingGateway(rp);
    mail = [];
    setMailTransport({ send: async (m) => void mail.push(m) });
  });
  afterEach(() => {
    setBillingGateway(null);
    setMailTransport(null);
    process.env.BILLING_MODE = "recurring";
    resetEnvCache();
  });

  it("charges the server-side price (plan + 18% GST) and ignores nothing from the client", async () => {
    const { actor } = await paidOrg("Price");
    const co = await startCheckout(actor, { planCode: "GROWTH", cycle: "MONTHLY" });
    expect(co.amountPaise).toBe(353_882); // ₹2,999 + 18% GST
    expect(co.keyId).toBe("rzp_test_fakekey");
    expect(co.testMode).toBe(true);
    const providerPlan = [...rp.plans.values()][0];
    expect(providerPlan).toEqual({ amount: 353_882, period: "monthly" });
  });

  it("REST: rejects client-supplied amounts and unknown plans", async () => {
    const { user, org } = await paidOrg("Rest");
    const s = await createSession({ userId: user.id, orgId: org.id });
    const call = (body: unknown) =>
      checkoutRoute(
        new NextRequest(`${APP}/api/billing/checkout`, {
          method: "POST",
          headers: { origin: APP, cookie: `${sessionCookieName()}=${s.token}`, "x-csrf-token": s.csrfToken, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({}) },
      );
    expect((await call({ planCode: "GROWTH", cycle: "MONTHLY", amount: 1 })).status).toBe(400);
    expect((await call({ planCode: "FREEBIE", cycle: "MONTHLY" })).status).toBe(400);
    const ok = await call({ planCode: "STARTER", cycle: "MONTHLY" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).checkout.amountPaise).toBe(117_882);
  });

  it("success: activates only after provider confirms the charge; issues one invoice", async () => {
    const { actor, org } = await paidOrg("Happy");
    const co = await startCheckout(actor, { planCode: "GROWTH", cycle: "MONTHLY" });
    expect((await getEntitlement(org.id)).active).toBe(false);

    // Customer authorised but provider has not collected yet → still not active.
    rp.authenticate(co.subscriptionId!);
    const fakePay = "pay_notcharged1";
    rp.payments.set(fakePay, { id: fakePay, amount: co.amountPaise, currency: "INR", status: "authorized" });
    await verifyCheckout(actor, checkoutResponse(co.subscriptionId!, fakePay));
    expect((await getEntitlement(org.id)).active).toBe(false);

    const pay = rp.charge(co.subscriptionId!);
    const overview = await verifyCheckout(actor, checkoutResponse(co.subscriptionId!, pay.id));
    expect(overview.entitlement).toMatchObject({ active: true, state: "ACTIVE", plan: { code: "GROWTH" } });
    expect(overview.subscription?.nextBillingDate).not.toBeNull();
    expect(await prisma.payment.count({ where: { orgId: org.id, status: "CAPTURED" } })).toBe(1);
    const invoices = await prisma.invoice.findMany({ where: { orgId: org.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ totalPaise: 353_882, subtotalPaise: 299_900, taxPaise: 53_982 });
    expect(invoices[0].number).toMatch(/^TXS-\d{4}-000001$/);
    expect(mail.some((m) => /subscription is active/.test(m.subject))).toBe(true);
  });

  it("forged checkout signature never activates", async () => {
    const { actor, org } = await paidOrg("Forged");
    const co = await startCheckout(actor, { planCode: "STARTER", cycle: "MONTHLY" });
    const pay = rp.charge(co.subscriptionId!);
    await expect(verifyCheckout(actor, { razorpay_payment_id: pay.id, razorpay_subscription_id: co.subscriptionId!, razorpay_signature: "0".repeat(64) })).rejects.toMatchObject({ status: 400, code: "invalid_signature" });
    expect((await getEntitlement(org.id)).active).toBe(false);
    expect(await prisma.billingAuditLog.count({ where: { action: "checkout.signature_invalid" } })).toBe(1);
  });

  it("webhooks: forged signature rejected and not stored; duplicates are idempotent; out-of-order converges", async () => {
    const { actor, org } = await paidOrg("Hooks");
    const co = await startCheckout(actor, { planCode: "GROWTH", cycle: "MONTHLY" });
    const subId = co.subscriptionId!;
    const pay = rp.charge(subId);

    // Forged: correct shape, wrong signature → 400, nothing stored, cannot pre-claim the event id.
    const forged = signedEvent("subscription.charged", { subscription: { entity: rp.subs.get(subId) }, payment: { entity: pay } }, "evt_real_1");
    const forgedRes = await webhookRoute(new NextRequest(`${APP}/api/webhooks/razorpay`, { method: "POST", headers: { "x-razorpay-signature": "f".repeat(64), "x-razorpay-event-id": "evt_real_1" }, body: forged.raw }));
    expect(forgedRes.status).toBe(400);
    expect(await prisma.paymentWebhookEvent.count()).toBe(0);
    expect((await getEntitlement(org.id)).active).toBe(false);

    // Real event (same id) is accepted.
    const res = await webhookRoute(new NextRequest(`${APP}/api/webhooks/razorpay`, { method: "POST", headers: { "x-razorpay-signature": forged.signature, "x-razorpay-event-id": "evt_real_1" }, body: forged.raw }));
    expect(res.status).toBe(200);
    const row = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt_real_1" } });
    await processWebhookEvent(row.id);
    expect((await getEntitlement(org.id)).active).toBe(true);

    // Duplicate delivery: acknowledged, not reprocessed.
    const dup = await deliver("subscription.charged", { subscription: { entity: rp.subs.get(subId) }, payment: { entity: pay } }, "evt_real_1");
    expect(dup).toMatchObject({ ok: true, duplicate: true });
    // Late, stale "authenticated" event after activation must not regress state.
    await deliver("subscription.authenticated", { subscription: { entity: { ...rp.subs.get(subId)!, status: "authenticated", paid_count: 0 } } });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { razorpaySubscriptionId: subId } });
    expect(sub.status).toBe("ACTIVE");
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("missed webhooks are recovered by reconciliation", async () => {
    const { actor, org } = await paidOrg("Missed");
    const co = await startCheckout(actor, { planCode: "STARTER", cycle: "MONTHLY" });
    rp.charge(co.subscriptionId!); // provider charged, but no webhook and no verify call
    expect((await getEntitlement(org.id)).active).toBe(false);
    await reconcileBilling();
    expect((await getEntitlement(org.id)).active).toBe(true);
  });

  it("failed renewal → past due with grace → service continues; grace over → monitoring paused; renewal → auto-resume", async () => {
    const { actor, org } = await paidOrg("Renew");
    const { co } = await subscribe(actor, "STARTER");
    const site = await makeConnectedSite(org.id);
    expect((await runAvailabilityCheck(site.id, { check: async () => up })).skipped).toBeUndefined();

    const failed = rp.failRenewal(co.subscriptionId!);
    await deliver("subscription.pending", { subscription: { entity: rp.subs.get(co.subscriptionId!) }, payment: { entity: failed } });
    const ent = await getEntitlement(org.id);
    expect(ent).toMatchObject({ active: true, state: "GRACE" });
    expect(await prisma.payment.count({ where: { status: "FAILED" } })).toBe(1);
    expect(mail.some((m) => /Payment for your subscription failed/.test(m.subject))).toBe(true);

    // Grace period elapses.
    await prisma.subscription.updateMany({ where: { orgId: org.id }, data: { graceUntil: new Date(Date.now() - 1000) } });
    rp.subs.get(co.subscriptionId!)!.status = "halted";
    await reconcileBilling();
    expect((await getEntitlement(org.id)).active).toBe(false);
    expect(await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).toMatchObject({ status: "MONITORING_PAUSED", pausedReason: "SUBSCRIPTION_INACTIVE" });
    expect((await runAvailabilityCheck(site.id, { check: async () => up })).skipped).toBe(true);
    expect(await prisma.finding.count()).toBe(0); // nothing deleted, nothing new

    // Customer fixes payment; Razorpay charges again.
    const pay2 = rp.charge(co.subscriptionId!);
    await deliver("subscription.charged", { subscription: { entity: rp.subs.get(co.subscriptionId!) }, payment: { entity: pay2 } });
    expect((await getEntitlement(org.id)).state).toBe("ACTIVE");
    expect(await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).toMatchObject({ status: "CONNECTED", pausedReason: null });
    expect(await prisma.invoice.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("cancellation at period end keeps service until the end date; immediate cancellation pauses now", async () => {
    const a = await paidOrg("CancelEnd");
    const { co } = await subscribe(a.actor, "STARTER");
    const view = await cancelSubscription(a.actor, { atPeriodEnd: true });
    expect(view.entitlement).toMatchObject({ active: true, state: "CANCELLING" });
    expect(view.subscription?.autoRenews).toBe(false);
    expect(rp.calls).toContain(`cancel:${co.subscriptionId}:true`);

    const b = await paidOrg("CancelNow");
    await subscribe(b.actor, "STARTER");
    const site = await makeConnectedSite(b.org.id);
    await cancelSubscription(b.actor, { atPeriodEnd: false });
    expect((await getEntitlement(b.org.id)).active).toBe(false);
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).status).toBe("MONITORING_PAUSED");
  });

  it("full refund ends the subscription, voids the invoice and pauses monitoring", async () => {
    const { actor, org } = await paidOrg("Refund");
    const { pay } = await subscribe(actor, "STARTER");
    const site = await makeConnectedSite(org.id);
    const refund = rp.refund(pay.id);
    await deliver("refund.processed", { refund: { entity: refund }, payment: { entity: rp.payments.get(pay.id) } });
    expect(await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId: pay.id } })).toMatchObject({ status: "REFUNDED", refundedPaise: pay.amount });
    expect((await prisma.invoice.findFirstOrThrow()).status).toBe("VOID");
    expect((await getEntitlement(org.id)).active).toBe(false);
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).status).toBe("MONITORING_PAUSED");
  });

  it("upgrade: new plan activates immediately and the old subscription is cancelled at the provider", async () => {
    const { actor, org } = await paidOrg("Upgrade");
    const first = await subscribe(actor, "STARTER");
    const co = await changePlan(actor, { planCode: "BUSINESS", cycle: "MONTHLY" });
    expect((await getEntitlement(org.id)).plan?.code).toBe("STARTER"); // unchanged until paid
    const pay = rp.charge(co.subscriptionId!);
    await verifyCheckout(actor, checkoutResponse(co.subscriptionId!, pay.id));
    expect((await getEntitlement(org.id)).plan?.code).toBe("BUSINESS");
    expect(rp.calls).toContain(`cancel:${first.co.subscriptionId}:false`);
    const old = await prisma.subscription.findFirstOrThrow({ where: { razorpaySubscriptionId: first.co.subscriptionId } });
    expect(old.status).toBe("CANCELLED");
  });

  it("downgrade: scheduled for period end; excess websites are paused (never deleted) when it takes effect", async () => {
    const { actor, org } = await paidOrg("Down");
    const first = await subscribe(actor, "GROWTH");
    const sites = [await makeConnectedSite(org.id, "a.example.com"), await makeConnectedSite(org.id, "b.example.com"), await makeConnectedSite(org.id, "c.example.com")];
    const co = await changePlan(actor, { planCode: "STARTER", cycle: "MONTHLY" });
    const pending = await prisma.subscription.findFirstOrThrow({ where: { razorpaySubscriptionId: co.subscriptionId } });
    expect(pending.scheduledStartAt).not.toBeNull();
    // Customer authorises the downgrade mandate → old subscription set to end at cycle end.
    rp.authenticate(co.subscriptionId!);
    await deliver("subscription.authenticated", { subscription: { entity: rp.subs.get(co.subscriptionId!) } });
    expect(rp.calls).toContain(`cancel:${first.co.subscriptionId}:true`);
    expect((await getEntitlement(org.id)).plan?.code).toBe("GROWTH");

    // Period ends: Growth cancelled, Starter charged.
    const growth = rp.subs.get(first.co.subscriptionId!)!;
    growth.status = "cancelled";
    growth.ended_at = Math.floor(Date.now() / 1000) - 10;
    growth.current_end = growth.ended_at;
    await deliver("subscription.cancelled", { subscription: { entity: growth } });
    const pay = rp.charge(co.subscriptionId!);
    await prisma.subscription.update({ where: { id: pending.id }, data: { scheduledStartAt: new Date(Date.now() - 1000) } });
    await deliver("subscription.charged", { subscription: { entity: { ...rp.subs.get(co.subscriptionId!)!, current_start: Math.floor(Date.now() / 1000) - 5 } }, payment: { entity: pay } });
    await prisma.subscription.update({ where: { id: pending.id }, data: { currentPeriodStart: new Date(Date.now() - 1000) } });
    await reconcileOrgMonitoring(org.id);

    expect((await getEntitlement(org.id)).plan?.code).toBe("STARTER");
    const after = await prisma.website.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } });
    expect(after).toHaveLength(3);
    expect(after.map((s) => [s.hostname, s.status, s.pausedReason])).toEqual([
      ["a.example.com", "CONNECTED", null],
      ["b.example.com", "MONITORING_PAUSED", "PLAN_LIMIT"],
      ["c.example.com", "MONITORING_PAUSED", "PLAN_LIMIT"],
    ]);
    expect(sites).toHaveLength(3);
  });

  it("prepaid mode: order payment captured once extends one period; duplicates don't double-extend; expiry after grace", async () => {
    process.env.BILLING_MODE = "prepaid";
    resetEnvCache();
    const { actor, org } = await paidOrg("Prepaid");
    const co = await startCheckout(actor, { planCode: "STARTER", cycle: "MONTHLY" });
    expect(co.mode).toBe("PREPAID");
    const pay = rp.payOrder(co.orderId!, "authorized"); // auto-capture off → server captures
    const body = { razorpay_payment_id: pay.id, razorpay_order_id: co.orderId!, razorpay_signature: signForTests(TEST_KEY_SECRET, `${co.orderId}|${pay.id}`) };
    await verifyCheckout(actor, body);
    const sub1 = await prisma.subscription.findFirstOrThrow({ where: { orgId: org.id, status: "ACTIVE" } });
    expect(sub1.paidCount).toBe(1);
    const end1 = sub1.currentPeriodEnd!;
    // Same payment again via webhook: no second period.
    await deliver("payment.captured", { payment: { entity: rp.payments.get(pay.id) } });
    await deliver("order.paid", { payment: { entity: rp.payments.get(pay.id) }, order: { entity: { id: co.orderId } } });
    const sub2 = await prisma.subscription.findUniqueOrThrow({ where: { id: sub1.id } });
    expect(sub2.paidCount).toBe(1);
    expect(sub2.currentPeriodEnd!.getTime()).toBe(end1.getTime());

    // Manual renewal extends from the current end date.
    const renewal = await renewSubscription(actor);
    const pay2 = rp.payOrder(renewal.orderId!);
    await deliver("payment.captured", { payment: { entity: pay2 } });
    const sub3 = await prisma.subscription.findUniqueOrThrow({ where: { id: sub1.id } });
    expect(sub3.paidCount).toBe(2);
    expect(sub3.currentPeriodEnd!.getTime()).toBeGreaterThan(end1.getTime() + 27 * 86_400_000);

    // Period over → past due (grace) → expired.
    await prisma.subscription.update({ where: { id: sub1.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    await reconcileBilling();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub1.id } })).status).toBe("PAST_DUE");
    expect((await getEntitlement(org.id)).state).toBe("GRACE");
    await prisma.subscription.update({ where: { id: sub1.id }, data: { graceUntil: new Date(Date.now() - 1000) } });
    await reconcileBilling();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub1.id } })).status).toBe("EXPIRED");
    expect((await getEntitlement(org.id)).active).toBe(false);
  });

  it("prepaid: failed payment records the failure and grants nothing", async () => {
    process.env.BILLING_MODE = "prepaid";
    resetEnvCache();
    const { actor, org } = await paidOrg("PrepaidFail");
    const co = await startCheckout(actor, { planCode: "STARTER", cycle: "MONTHLY" });
    const failed = rp.payOrder(co.orderId!, "failed");
    await deliver("payment.failed", { payment: { entity: failed } });
    expect(await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId: failed.id } })).toMatchObject({ status: "FAILED" });
    expect((await getEntitlement(org.id)).active).toBe(false);
  });

  it("abandoned checkouts expire and never grant access", async () => {
    const { actor, org } = await paidOrg("Abandon");
    await startCheckout(actor, { planCode: "STARTER", cycle: "MONTHLY" });
    await prisma.subscription.updateMany({ where: { orgId: org.id }, data: { createdAt: new Date(Date.now() - 48 * 3600_000) } });
    await reconcileBilling();
    expect((await prisma.subscription.findFirstOrThrow({ where: { orgId: org.id } })).status).toBe("ABANDONED");
  });
});

describe.skipIf(!hasTestDb)("billing ↔ monitoring: payment + verification + authorization are all required", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    rp = new FakeRazorpay();
    setBillingGateway(rp);
    setMailTransport({ send: async () => undefined });
  });
  afterEach(() => {
    setBillingGateway(null);
    setMailTransport(null);
  });

  const pass = async () => ({ ok: true, detail: "ok" });

  it("no subscription: cannot add websites", async () => {
    const { actor } = await paidOrg("NoPlan");
    await expect(createWebsite(actor, { url: "example.com" })).rejects.toMatchObject({ status: 402, code: "subscription_required" });
  });

  it("paid but unverified: website is Pending Verification and not monitored", async () => {
    const { actor, org } = await paidOrg("Paid");
    await subscribe(actor, "STARTER");
    const w = await createWebsite(actor, { url: "example.com" });
    expect(w.status).toBe("PENDING_VERIFICATION");
    let checks = 0;
    await runAvailabilityCheck(w.id, { check: async () => (checks++, up) });
    expect(checks).toBe(0);
    const overview = await billingOverview(org.id);
    expect(overview.entitlement.active).toBe(true);
    expect(overview.usage).toMatchObject({ websites: 1, connectedWebsites: 0 });
  });

  it("paid + verified + authorized → monitoring starts; Starter limit enforced at 1 website", async () => {
    const { actor } = await paidOrg("Full");
    await subscribe(actor, "STARTER");
    const w = await createWebsite(actor, { url: "example.com" });
    const queued: string[] = [];
    const v = await verifyWebsite(actor, w.id, { method: "DNS_TXT", authorizationConfirmed: true }, { dns: pass, enqueue: async (id) => void queued.push(id) });
    expect(v.website.status).toBe("CONNECTED");
    expect(queued).toEqual([w.id]);
    let checks = 0;
    await runAvailabilityCheck(w.id, { check: async () => (checks++, up) });
    expect(checks).toBe(1);
    await expect(createWebsite(actor, { url: "second.example.com" })).rejects.toMatchObject({ status: 400, code: "plan_limit" });
  });

  it("existing customers: complimentary grant keeps monitoring; revoking it pauses; payment resumes", async () => {
    const admin = await makeOrg("Admin");
    const { actor, org } = await paidOrg("Legacy");
    const site = await makeConnectedSite(org.id);
    await reconcileOrgMonitoring(org.id);
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).status).toBe("MONITORING_PAUSED");
    const grant = await adminGrantComplimentary(admin.user.id, { orgId: org.id, planCode: "GROWTH", days: 30, reason: "Existing customer migration" });
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).status).toBe("CONNECTED");
    expect(await prisma.payment.count()).toBe(0); // grants never fabricate payments
    await adminRevokeComplimentary(admin.user.id, grant.id);
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).status).toBe("MONITORING_PAUSED");
    await subscribe(actor, "STARTER");
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).status).toBe("CONNECTED");
  });

  it("customer-paused websites are never auto-resumed by billing", async () => {
    const { org } = await makeOrg("UserPause");
    const site = await makeConnectedSite(org.id);
    await prisma.website.update({ where: { id: site.id }, data: { status: "MONITORING_PAUSED", pausedReason: "USER" } });
    await reconcileOrgMonitoring(org.id);
    expect(await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).toMatchObject({ status: "MONITORING_PAUSED", pausedReason: "USER" });
  });

  it("feature gating: Starter has no AI or audit logs; team size limited", async () => {
    const { actor, org } = await paidOrg("Gate");
    await subscribe(actor, "STARTER");
    const ent = await getEntitlement(org.id);
    expect(ent.limits).toMatchObject({ websites: 1, members: 1, aiAssistant: false, auditLogs: false, scheduledReports: false });
    const { inviteMember } = await import("@/server/services/auth");
    await expect(inviteMember(actor, { email: "x@example.com", role: "MEMBER" })).rejects.toMatchObject({ code: "plan_limit" });
    const { prioritize } = await import("@/server/ai/assistant");
    const { setAiProvider } = await import("@/server/ai/provider");
    setAiProvider({ name: "fake", model: "f", complete: async () => "x" });
    await expect(prioritize(actor)).rejects.toMatchObject({ code: "plan_feature" });
    setAiProvider(undefined);
  });
});

describe.skipIf(!hasTestDb)("billing isolation and admin controls", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    rp = new FakeRazorpay();
    setBillingGateway(rp);
    setMailTransport({ send: async () => undefined });
  });
  afterEach(() => {
    setBillingGateway(null);
    setMailTransport(null);
  });

  it("cannot verify another organization's checkout or download its invoice", async () => {
    const a = await paidOrg("A");
    const b = await paidOrg("B");
    const coB = await startCheckout(b.actor, { planCode: "STARTER", cycle: "MONTHLY" });
    const pay = rp.charge(coB.subscriptionId!);
    await expect(verifyCheckout(a.actor, checkoutResponse(coB.subscriptionId!, pay.id))).rejects.toMatchObject({ status: 404 });
    await verifyCheckout(b.actor, checkoutResponse(coB.subscriptionId!, pay.id));
    const inv = await prisma.invoice.findFirstOrThrow({ where: { orgId: b.org.id } });
    const s = await createSession({ userId: a.user.id, orgId: a.org.id });
    const res = await invoicePdfRoute(new NextRequest(`${APP}/api/billing/invoices/${inv.id}/pdf`, { headers: { cookie: `${sessionCookieName()}=${s.token}` } }), { params: Promise.resolve({ id: inv.id }) });
    expect(res.status).toBe(404);
    const sb = await createSession({ userId: b.user.id, orgId: b.org.id });
    const ok = await invoicePdfRoute(new NextRequest(`${APP}/api/billing/invoices/${inv.id}/pdf`, { headers: { cookie: `${sessionCookieName()}=${sb.token}` } }), { params: Promise.resolve({ id: inv.id }) });
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("only owners/admins manage billing", async () => {
    const { actor } = await paidOrg("Viewer");
    await expect(startCheckout({ ...actor, role: "VIEWER" }, { planCode: "STARTER", cycle: "MONTHLY" })).rejects.toMatchObject({ status: 403 });
    await expect(startCheckout({ ...actor, role: "MEMBER" }, { planCode: "STARTER", cycle: "MONTHLY" })).rejects.toMatchObject({ status: 403 });
  });

  it("admin console requires platform admin; price edits only affect new checkouts", async () => {
    const { user, org, actor } = await paidOrg("Op");
    const s = await createSession({ userId: user.id, orgId: org.id });
    const res = await adminBillingRoute(new NextRequest(`${APP}/api/admin/billing`, { headers: { cookie: `${sessionCookieName()}=${s.token}` } }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);

    const first = await subscribe(actor, "STARTER");
    await expect(adminUpdatePlan(user.id, "STARTER", { monthlyPricePaise: 149_900 }, "WRONG")).rejects.toMatchObject({ status: 400 });
    await adminUpdatePlan(user.id, "STARTER", { monthlyPricePaise: 149_900 }, "STARTER");
    const existing = await prisma.subscription.findFirstOrThrow({ where: { razorpaySubscriptionId: first.co.subscriptionId } });
    expect(existing.amountPaise).toBe(117_882); // unchanged
    const other = await paidOrg("NewCustomer");
    const co = await startCheckout(other.actor, { planCode: "STARTER", cycle: "MONTHLY" });
    expect(co.amountPaise).toBe(176_882); // ₹1,499 + GST
    expect(await prisma.billingAuditLog.count({ where: { action: "plan.updated" } })).toBe(1);
  });
});

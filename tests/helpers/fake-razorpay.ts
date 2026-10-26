import { randomBytes } from "node:crypto";
import type { BillingGateway, ProviderOrder, ProviderPayment, ProviderSubscription } from "@/server/billing/gateway";
import { signWebhookBody } from "@/server/billing/signatures";

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString("hex")}`;
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * In-memory stand-in for Razorpay used only by tests. It models the provider-side state that
 * our code must treat as authoritative (subscription status, paid_count, periods, payments).
 */
export class FakeRazorpay implements BillingGateway {
  plans = new Map<string, { amount: number; period: string }>();
  subs = new Map<string, ProviderSubscription>();
  orders = new Map<string, ProviderOrder>();
  payments = new Map<string, ProviderPayment>();
  calls: string[] = [];

  async createPlan(p: { period: "monthly" | "yearly"; amountPaise: number }) {
    const planId = id("plan");
    this.plans.set(planId, { amount: p.amountPaise, period: p.period });
    this.calls.push(`createPlan:${p.amountPaise}`);
    return { id: planId };
  }

  async createSubscription(p: { planId: string; totalCount: number; startAt?: number; notes: Record<string, string> }) {
    const sub: ProviderSubscription = {
      id: id("sub"),
      plan_id: p.planId,
      status: "created",
      current_start: null,
      current_end: null,
      charge_at: p.startAt ?? null,
      ended_at: null,
      paid_count: 0,
      total_count: p.totalCount,
      notes: p.notes,
    };
    this.subs.set(sub.id, sub);
    this.calls.push(`createSubscription:${p.planId}`);
    return { ...sub };
  }

  async fetchSubscription(subId: string) {
    const s = this.subs.get(subId);
    if (!s) throw Object.assign(new Error("not found"), { error: { description: "The id provided does not exist" } });
    return { ...s };
  }

  async cancelSubscription(subId: string, atCycleEnd: boolean) {
    const s = this.subs.get(subId)!;
    this.calls.push(`cancel:${subId}:${atCycleEnd}`);
    if (!atCycleEnd) {
      s.status = "cancelled";
      s.ended_at = nowS();
    }
    return { ...s };
  }

  async createOrder(p: { amountPaise: number; currency: string }) {
    const o: ProviderOrder = { id: id("order"), amount: p.amountPaise, currency: p.currency, status: "created" };
    this.orders.set(o.id, o);
    return { ...o };
  }

  async fetchPayment(payId: string) {
    const p = this.payments.get(payId);
    if (!p) throw Object.assign(new Error("not found"), { error: { description: "payment not found" } });
    return { ...p };
  }

  async capturePayment(payId: string) {
    const p = this.payments.get(payId)!;
    if (p.status === "authorized") p.status = "captured";
    return { ...p };
  }

  // ─── provider-side simulations ───

  /** Customer authorises the mandate (no charge yet). */
  authenticate(subId: string) {
    this.subs.get(subId)!.status = "authenticated";
  }

  /** A successful charge: subscription active, new period, captured payment. */
  charge(subId: string): ProviderPayment {
    const s = this.subs.get(subId)!;
    const plan = this.plans.get(s.plan_id)!;
    // A charge starts the cycle it pays for at the moment it is collected.
    const start = nowS();
    const end = start + (plan.period === "yearly" ? 365 : 30) * 86_400;
    s.status = "active";
    s.paid_count += 1;
    s.current_start = start;
    s.current_end = end;
    s.charge_at = end;
    const pay: ProviderPayment = { id: id("pay"), amount: plan.amount, currency: "INR", status: "captured", method: "card", invoice_id: id("inv"), amount_refunded: 0 };
    this.payments.set(pay.id, pay);
    return { ...pay };
  }

  /** Renewal charge failed; Razorpay retries (status pending). */
  failRenewal(subId: string): ProviderPayment {
    const s = this.subs.get(subId)!;
    s.status = "pending";
    const plan = this.plans.get(s.plan_id)!;
    const pay: ProviderPayment = { id: id("pay"), amount: plan.amount, currency: "INR", status: "failed", error_code: "BAD_REQUEST_ERROR", error_description: "Card declined", amount_refunded: 0 };
    this.payments.set(pay.id, pay);
    return { ...pay };
  }

  /** Customer pays a one-time order. */
  payOrder(orderId: string, status: "captured" | "authorized" | "failed" = "captured"): ProviderPayment {
    const o = this.orders.get(orderId)!;
    const pay: ProviderPayment = { id: id("pay"), amount: o.amount, currency: o.currency, status, order_id: o.id, method: "upi", amount_refunded: 0 };
    if (status !== "failed") o.status = "paid";
    this.payments.set(pay.id, pay);
    return { ...pay };
  }

  refund(payId: string, amount?: number) {
    const p = this.payments.get(payId)!;
    p.amount_refunded = amount ?? p.amount;
    if (p.amount_refunded >= p.amount) p.status = "refunded";
    return { id: id("rfnd"), payment_id: payId, amount: p.amount_refunded };
  }
}

export const TEST_KEY_SECRET = "test_key_secret_123";
export const TEST_WEBHOOK_SECRET = "test_webhook_secret_456";

/** Builds a webhook request exactly as Razorpay would sign it. */
export function signedEvent(event: string, payload: Record<string, unknown>, eventId = id("evt")) {
  const raw = Buffer.from(JSON.stringify({ entity: "event", event, payload, created_at: nowS() }));
  return { raw, signature: signWebhookBody(raw, TEST_WEBHOOK_SECRET), eventId };
}

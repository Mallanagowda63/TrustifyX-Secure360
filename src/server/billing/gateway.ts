import Razorpay from "razorpay";
import { env } from "../env";

/** Subset of the Razorpay subscription entity used for billing state (timestamps: unix seconds). */
export interface ProviderSubscription {
  id: string;
  plan_id: string;
  status: string; // created | authenticated | active | pending | halted | cancelled | completed | expired | paused
  current_start: number | null;
  current_end: number | null;
  charge_at: number | null;
  ended_at: number | null;
  paid_count: number;
  total_count: number;
  short_url?: string;
  notes?: Record<string, string>;
}

export interface ProviderPayment {
  id: string;
  amount: number;
  currency: string;
  status: string; // created | authorized | captured | refunded | failed
  order_id?: string | null;
  invoice_id?: string | null;
  method?: string | null;
  amount_refunded?: number;
  error_code?: string | null;
  error_description?: string | null;
  created_at?: number;
  notes?: Record<string, string> | unknown[];
}

export interface ProviderOrder {
  id: string;
  amount: number;
  currency: string;
  status: string; // created | attempted | paid
}

export interface BillingGateway {
  createPlan(p: { period: "monthly" | "yearly"; amountPaise: number; currency: string; name: string; description: string; notes: Record<string, string> }): Promise<{ id: string }>;
  createSubscription(p: { planId: string; totalCount: number; startAt?: number; notes: Record<string, string> }): Promise<ProviderSubscription>;
  fetchSubscription(id: string): Promise<ProviderSubscription>;
  cancelSubscription(id: string, atCycleEnd: boolean): Promise<ProviderSubscription>;
  createOrder(p: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<ProviderOrder>;
  fetchPayment(id: string): Promise<ProviderPayment>;
  capturePayment(id: string, amountPaise: number, currency: string): Promise<ProviderPayment>;
}

export class BillingNotConfiguredError extends Error {
  constructor() {
    super("Online payments are not configured yet. Please contact support.");
  }
}

export function razorpayConfigured(): boolean {
  const e = env();
  return Boolean(e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET);
}

export function isTestMode(): boolean {
  return (env().RAZORPAY_KEY_ID ?? "").startsWith("rzp_test_");
}

function razorpayGateway(): BillingGateway {
  const e = env();
  const rp = new Razorpay({ key_id: e.RAZORPAY_KEY_ID!, key_secret: e.RAZORPAY_KEY_SECRET! });
  return {
    async createPlan(p) {
      const plan = await rp.plans.create({
        period: p.period,
        interval: 1,
        item: { name: p.name, amount: p.amountPaise, currency: p.currency, description: p.description },
        notes: p.notes,
      });
      return { id: plan.id };
    },
    async createSubscription(p) {
      const sub = await rp.subscriptions.create({
        plan_id: p.planId,
        total_count: p.totalCount,
        quantity: 1,
        customer_notify: true,
        ...(p.startAt ? { start_at: p.startAt } : {}),
        notes: p.notes,
      });
      return sub as unknown as ProviderSubscription;
    },
    async fetchSubscription(id) {
      return (await rp.subscriptions.fetch(id)) as unknown as ProviderSubscription;
    },
    async cancelSubscription(id, atCycleEnd) {
      return (await rp.subscriptions.cancel(id, atCycleEnd)) as unknown as ProviderSubscription;
    },
    async createOrder(p) {
      const o = await rp.orders.create({ amount: p.amountPaise, currency: p.currency, receipt: p.receipt, notes: p.notes });
      return { id: o.id, amount: Number(o.amount), currency: o.currency, status: o.status };
    },
    async fetchPayment(id) {
      return (await rp.payments.fetch(id)) as unknown as ProviderPayment;
    },
    async capturePayment(id, amountPaise, currency) {
      return (await rp.payments.capture(id, amountPaise, currency)) as unknown as ProviderPayment;
    },
  };
}

let override: BillingGateway | null = null;

/** Tests inject a fake provider here. */
export function setBillingGateway(g: BillingGateway | null) {
  override = g;
}

export function billingGateway(): BillingGateway {
  if (override) return override;
  if (!razorpayConfigured()) throw new BillingNotConfiguredError();
  return razorpayGateway();
}

export function gatewayAvailable(): boolean {
  return Boolean(override) || razorpayConfigured();
}

/** Razorpay SDK errors carry `error.description`; normalise for logs and API messages. */
export function providerErrorMessage(err: unknown): string {
  const e = err as { error?: { description?: string }; message?: string; statusCode?: number };
  return (e?.error?.description ?? e?.message ?? "Payment provider error").slice(0, 300);
}

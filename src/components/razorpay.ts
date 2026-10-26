"use client";

import { api } from "@/lib/client";

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

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
  razorpay_order_id?: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (resp: { error: { description?: string; reason?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

let loader: Promise<void> | null = null;

/** Loads the official Razorpay Checkout script once. */
export function loadRazorpay(): Promise<void> {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve();
  loader ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = null;
      reject(new Error("Could not load Razorpay Checkout. Check your connection and try again."));
    };
    document.body.appendChild(s);
  });
  return loader;
}

export type CheckoutOutcome = { status: "paid" } | { status: "dismissed" } | { status: "failed"; message: string };

/**
 * Opens Razorpay Checkout for a server-created subscription/order and sends the signed
 * response to our backend for verification. The browser result alone never activates a plan.
 */
export async function runCheckout(co: CheckoutPayload): Promise<CheckoutOutcome> {
  await loadRazorpay();
  return new Promise((resolve) => {
    let settled = false;
    const done = (o: CheckoutOutcome) => {
      if (!settled) {
        settled = true;
        resolve(o);
      }
    };
    const rzp = new window.Razorpay!({
      key: co.keyId,
      ...(co.subscriptionId ? { subscription_id: co.subscriptionId } : { order_id: co.orderId, amount: co.amountPaise, currency: co.currency }),
      name: co.name,
      description: co.description,
      prefill: co.prefill,
      notes: { localSubscriptionId: co.localSubscriptionId },
      theme: { color: "#2563eb" },
      handler: async (resp: RazorpayResponse) => {
        try {
          await api("/api/billing/verify", { body: resp });
          done({ status: "paid" });
        } catch (err) {
          done({ status: "failed", message: (err as Error).message });
        }
      },
      modal: { ondismiss: () => done({ status: "dismissed" }) },
    });
    rzp.on("payment.failed", (resp) => {
      // Razorpay lets the customer retry inside the modal; record the reason for display.
      lastFailure = resp.error?.description ?? resp.error?.reason ?? "Payment failed";
    });
    rzp.open();
  });
}

export let lastFailure: string | null = null;
export function consumeLastFailure() {
  const f = lastFailure;
  lastFailure = null;
  return f;
}

/** After payment, waits for the server to confirm activation (webhook or provider sync). */
export async function waitForActivation(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < timeoutMs) {
    const o = await api<{ entitlement: { active: boolean; state: string }; pending: { scheduledStartAt: string | null } | null }>(
      i % 3 === 2 ? "/api/billing/sync" : "/api/billing/overview",
      i % 3 === 2 ? { method: "POST" } : {},
    ).catch(() => null);
    // Done when active with no outstanding checkout; a scheduled downgrade stays pending until period end.
    if (o?.entitlement.active && (!o.pending || o.pending.scheduledStartAt)) return true;
    i++;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

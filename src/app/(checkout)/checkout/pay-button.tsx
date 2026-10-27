"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Notice } from "@/components/ui";
import { consumeLastFailure, runCheckout, waitForActivation, type CheckoutPayload } from "@/components/razorpay";

export function PayButton({ planCode, cycle, change, totalLabel, addon = false }: { planCode: string; cycle: "MONTHLY" | "ANNUAL"; change: boolean; totalLabel: string; addon?: boolean }) {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "info" | "error" | "success" | "warn"; text: string } | null>(null);

  async function pay() {
    setBusy(true);
    setMsg(null);
    try {
      const { checkout } = addon
        ? await api<{ checkout: CheckoutPayload }>("/api/billing/addons/checkout", { body: { addonCode: planCode, cycle } })
        : await api<{ checkout: CheckoutPayload }>(change ? "/api/billing/change-plan" : "/api/billing/checkout", { body: { planCode, cycle } });
      const outcome = await runCheckout(checkout);
      if (outcome.status === "dismissed") {
        const failure = consumeLastFailure();
        setMsg(failure ? { tone: "error", text: `Payment failed: ${failure}. You have not been charged for a failed payment. Please try again.` } : { tone: "info", text: "Checkout closed. You have not been charged." });
        setBusy(false);
        return;
      }
      if (outcome.status === "failed") {
        setMsg({ tone: "error", text: `We could not verify this payment: ${outcome.message}. If money was debited, it will be reconciled automatically. Contact support if your plan is not active within an hour.` });
        setBusy(false);
        return;
      }
      setMsg({ tone: "info", text: "Payment received. Waiting for Razorpay to confirm it…" });
      const active = await waitForActivation(60_000, addon ? planCode : undefined);
      if (active) {
        setMsg({ tone: "success", text: addon ? "Payment verified. The add-on is active. Redirecting…" : "Payment verified. Your subscription is active. Redirecting…" });
        window.location.assign(addon ? "/account/billing?addon=1" : "/account?paid=1");
      } else {
        setMsg({ tone: "warn", text: "Payment Confirmation Pending. This can take a few minutes; your plan activates automatically once Razorpay confirms it." });
        window.location.assign("/account");
        setBusy(false);
      }
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-ink-muted">
        <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I agree to the Terms of Service and the Refund &amp; Cancellation Policy.</span>
      </label>
      <button className="btn btn-primary w-full py-3 text-base" disabled={!agreed || busy} onClick={pay}>
        {busy ? "Processing…" : `Pay ${totalLabel} securely`}
      </button>
      {msg && <Notice tone={msg.tone === "warn" ? "warn" : msg.tone}>{msg.text}</Notice>}
    </div>
  );
}

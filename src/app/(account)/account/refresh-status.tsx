"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";

/** Asks the backend to re-check Razorpay; the plan activates only from the provider's state. */
export function RefreshPaymentStatus() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        className="btn btn-primary px-5 py-3 text-base"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const o = await api<{ entitlement: { active: boolean } }>("/api/billing/sync", { method: "POST" });
            setMsg(o.entitlement.active ? "Payment confirmed." : "Still waiting for confirmation from Razorpay. Please try again shortly.");
            router.refresh();
          } catch (err) {
            setMsg((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Checking…" : "Refresh payment status"}
      </button>
      {msg && <span className="text-sm text-ink-muted">{msg}</span>}
    </div>
  );
}

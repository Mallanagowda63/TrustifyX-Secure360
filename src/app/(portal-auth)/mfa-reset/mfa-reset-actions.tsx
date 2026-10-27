"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";

/** Explicit buttons (POST) so email link scanners that prefetch URLs cannot confirm a reset. */
export function MfaResetActions({ token }: { token: string }) {
  const [state, setState] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(kind: "confirm" | "cancel") {
    setBusy(true);
    try {
      if (kind === "confirm") {
        const r = await api<{ effectiveAt: string | null }>("/api/auth/mfa/reset-confirm", { body: { token } });
        const when = r.effectiveAt ? new Date(r.effectiveAt).toLocaleString() : "after the waiting period";
        setState({ tone: "ok", text: `Confirmed. Two-factor authentication will be removed on ${when}. Sign in after that time with your email and password, then set it up again.` });
      } else {
        const r = await api<{ cancelled: boolean }>("/api/auth/mfa/reset-cancel", { body: { token } });
        setState({ tone: "ok", text: r.cancelled ? "The reset was cancelled. Your two-factor authentication stays on." : "There was nothing to cancel." });
      }
    } catch (err) {
      setState({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-6">
      <p className="text-slate-400">
        Someone who knows your password asked to remove two-factor authentication because the authenticator app and recovery codes were lost. For your
        safety the removal only happens after a waiting period, and you will receive emails about it.
      </p>
      {state && (
        <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${state.tone === "ok" ? "border-sky-400/40 bg-sky-500/10 text-sky-100" : "border-red-500/40 bg-red-500/10 text-red-100"}`}>
          {state.text}
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button className="portal-btn-primary flex-1" disabled={busy} onClick={() => act("confirm")}>Yes, this was me: start the reset</button>
        <button className="flex-1 rounded-lg border border-white/15 px-4 py-3 font-semibold text-slate-200 hover:bg-white/5" disabled={busy} onClick={() => act("cancel")}>
          This wasn&apos;t me: cancel
        </button>
      </div>
      <p className="text-sm text-slate-500">
        If this wasn&apos;t you, also <Link href="/forgot-password" className="text-royal-400 hover:text-royal-200">change your password</Link>.
      </p>
    </div>
  );
}

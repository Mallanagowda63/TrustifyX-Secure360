"use client";

import { useState } from "react";
import { api } from "@/lib/client";

export function ResetForm({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get("password") !== fd.get("confirm")) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/reset-password", { body: { token, password: fd.get("password") } });
      window.location.assign("/login?reset=1");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-5">
      <p className="text-sm text-slate-400">After changing your password you will be signed out on all devices and both TrustifyX websites.</p>
      {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>}
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-300">New password</span>
        <input name="password" type="password" autoComplete="new-password" minLength={12} required className="portal-input" />
        <span className="mt-1 block text-xs text-slate-500">At least 12 characters. A passphrase works well.</span>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-slate-300">Confirm new password</span>
        <input name="confirm" type="password" autoComplete="new-password" required className="portal-input" />
      </label>
      <button className="portal-btn-primary w-full" disabled={busy}>{busy ? "Saving…" : "Set new password"}</button>
    </form>
  );
}

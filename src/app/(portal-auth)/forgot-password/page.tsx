"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string }>("/api/auth/forgot-password", { body: { email: new FormData(e.currentTarget).get("email") } });
      setDone(r.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal-fade-in">
      <h1 className="font-display text-3xl font-bold text-white">Reset your password</h1>
      <p className="mt-3 text-slate-400">Enter the email address you use for TrustifyX Secure360. We will send you a link to choose a new password.</p>
      {done ? (
        <div role="status" className="mt-8 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-4 text-sm text-emerald-100">{done}</div>
      ) : (
        <form onSubmit={onSubmit} className="mt-8 space-y-5">
          {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>}
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-300">Email Address</span>
            <input name="email" type="email" autoComplete="email" required className="portal-input" />
          </label>
          <button className="portal-btn-primary w-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
        </form>
      )}
      <p className="mt-8 text-center text-sm text-slate-500">
        <Link href="/login" className="font-medium text-royal-400 hover:text-royal-200">← Back to sign in</Link>
      </p>
    </div>
  );
}

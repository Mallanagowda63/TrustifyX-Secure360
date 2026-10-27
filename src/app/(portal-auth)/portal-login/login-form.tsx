"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ClientApiError } from "@/lib/client";
import { Icon } from "@/components/marketing/Icon";

const MESSAGES: Record<string, string> = {
  invalid_credentials: "The email or password is incorrect.",
  locked: "This account is temporarily locked after repeated failed sign-ins. Try again in 15 minutes or reset your password.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  invalid_code: "That code is not valid. Try the newest code from your authenticator app.",
  mfa_challenge_expired: "Your sign-in attempt expired. Enter your email and password again.",
};

const messageFor = (err: unknown, fallback: string) => {
  const code = err instanceof ClientApiError ? err.code : undefined;
  return (code && MESSAGES[code]) || (err as Error).message || fallback;
};

export function PortalLoginForm({ next, plansUrl, notice }: { next: string; plansUrl: string; notice: string | null }) {
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ mfaRequired?: boolean }>("/api/auth/login", { body: { email: fd.get("email"), password: fd.get("password"), remember } });
      if (res.mfaRequired) {
        setMfa(true);
        setBusy(false);
        return;
      }
      // Full navigation so the server renders the portal with the new session cookie.
      window.location.assign(next);
    } catch (err) {
      setError(messageFor(err, "Sign-in failed. Please try again."));
      setBusy(false);
    }
  }

  if (mfa) {
    return (
      <PortalMfaStep
        next={next}
        onRestart={(msg) => {
          setMfa(false);
          setError(msg);
        }}
      />
    );
  }

  return (
    <div className="portal-fade-in">
      <h1 className="font-display text-3xl leading-tight font-bold text-white">Welcome Back to Your Security Command Center</h1>
      <p className="mt-3 text-slate-400">Sign in to monitor, analyze and protect your websites.</p>

      {notice && <div role="status" className="mt-6 rounded-lg border border-sky-400/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">{notice}</div>}
      {error && (
        <div role="alert" className="mt-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate={false}>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-300">Email Address</span>
          <input name="email" type="email" autoComplete="email" required className="portal-input" placeholder="you@company.com" />
        </label>
        <label className="block">
          <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-slate-300">
            Password
            <Link href="/forgot-password" className="text-xs font-medium text-royal-400 hover:text-royal-200">
              Forgot password?
            </Link>
          </span>
          <span className="relative block">
            <input name="password" type={show ? "text" : "password"} autoComplete="current-password" required className="portal-input pr-12" />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-slate-400 hover:text-white"
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
            >
              <Icon name={show ? "x" : "eye"} className="h-5 w-5" />
            </button>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-[#2563eb]" />
          Keep me signed in on this device
        </label>
        <button type="submit" disabled={busy} className="portal-btn-primary w-full">
          {busy ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> Signing in…
            </>
          ) : (
            <>
              Sign in securely <Icon name="arrow" className="h-4 w-4" />
            </>
          )}
        </button>
      </form>

      <p className="mt-8 text-center text-sm text-slate-500">
        New to TrustifyX?{" "}
        <a href={plansUrl} className="font-medium text-teal-300 hover:text-teal-200">
          Explore Plans
        </a>
      </p>
      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-600">
        <Icon name="lock" className="h-3.5 w-3.5" /> Protected connection · TrustifyX Private Limited
      </p>
    </div>
  );
}

/** Second sign-in step: authenticator code, or a one-time recovery code. */
function PortalMfaStep({ next, onRestart }: { next: string; onRestart: (message: string | null) => void }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/mfa/verify", { body: useRecovery ? { recoveryCode: value } : { code: value } });
      window.location.assign(next);
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "mfa_challenge_expired") return onRestart(MESSAGES.mfa_challenge_expired);
      setError(messageFor(err, "Verification failed. Please try again."));
      setBusy(false);
    }
  }

  async function lostAccess() {
    setError(null);
    try {
      const r = await api<{ message: string }>("/api/auth/mfa/reset-request", { body: {} });
      setNotice(r.message);
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "mfa_challenge_expired") return onRestart(MESSAGES.mfa_challenge_expired);
      setError(messageFor(err, "Could not start the reset. Please try again."));
    }
  }

  return (
    <div className="portal-fade-in">
      <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-royal-600 to-teal-500">
        <Icon name="lock" className="h-6 w-6 text-white" />
      </div>
      <h1 className="font-display text-3xl leading-tight font-bold text-white">Two-Factor Verification</h1>
      <p className="mt-3 text-slate-400">
        {useRecovery ? "Enter one of your saved recovery codes. Each code works once." : "Enter the 6-digit code from your authenticator app."}
      </p>
      {notice && <div role="status" className="mt-6 rounded-lg border border-sky-400/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">{notice}</div>}
      {error && <div role="alert" className="mt-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>}
      <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-300">{useRecovery ? "Recovery code" : "Authentication code"}</span>
          <input
            key={useRecovery ? "recovery" : "totp"}
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode={useRecovery ? "text" : "numeric"}
            pattern={useRecovery ? undefined : "[0-9 ]{6,7}"}
            maxLength={useRecovery ? 20 : 7}
            placeholder={useRecovery ? "xxxxx-xxxxx" : "123 456"}
            className="portal-input text-center font-mono text-lg tracking-[0.3em]"
          />
        </label>
        <button type="submit" disabled={busy} className="portal-btn-primary w-full">
          {busy ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> Verifying…
            </>
          ) : (
            <>
              Verify and sign in <Icon name="arrow" className="h-4 w-4" />
            </>
          )}
        </button>
      </form>
      <div className="mt-6 flex flex-col items-center gap-3 text-sm">
        <button type="button" onClick={() => { setUseRecovery((v) => !v); setError(null); }} className="font-medium text-royal-400 hover:text-royal-200">
          {useRecovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
        </button>
        <button type="button" onClick={lostAccess} className="text-slate-500 hover:text-slate-300">
          Lost your authenticator and recovery codes?
        </button>
        <button type="button" onClick={() => onRestart(null)} className="text-slate-500 hover:text-slate-300">
          ← Back to sign in
        </button>
      </div>
    </div>
  );
}

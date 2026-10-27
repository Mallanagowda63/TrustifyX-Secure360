"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, ClientApiError } from "@/lib/client";
import { Field } from "@/components/Field";
import { Notice } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(
    params.get("error") === "no_org" ? "Your account is not a member of any organization." : null,
  );
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function destination() {
    const next = params.get("next");
    // Only same-site relative paths are accepted (no open redirect via "//host" or "/\host").
    const safe = next && next.startsWith("/") && next[1] !== "/" && next[1] !== "\\";
    return safe ? next : "/account";
  }

  async function onVerify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/mfa/verify", { body: useRecovery ? { recoveryCode: value } : { code: value } });
      window.location.assign(destination());
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "mfa_challenge_expired") setMfa(false);
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function lostAccess() {
    try {
      setNotice((await api<{ message: string }>("/api/auth/mfa/reset-request", { body: {} })).message);
    } catch (err) {
      if (err instanceof ClientApiError && err.code === "mfa_challenge_expired") setMfa(false);
      setError((err as Error).message);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ mfaRequired?: boolean }>("/api/auth/login", { body: { email: fd.get("email"), password: fd.get("password") } });
      if (res.mfaRequired) {
        setMfa(true);
        setBusy(false);
        return;
      }
      // Full navigation so server-rendered pages see the new session cookie.
      window.location.assign(destination());
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (mfa) {
    return (
      <form onSubmit={onVerify} className="card space-y-4 p-6">
        <h1 className="text-xl font-semibold">Two-factor verification</h1>
        <p className="text-sm text-ink-muted">
          {useRecovery ? "Enter one of your saved recovery codes. Each code works once." : "Enter the 6-digit code from your authenticator app."}
        </p>
        {notice && <Notice tone="info">{notice}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <Field
          key={useRecovery ? "recovery" : "totp"}
          label={useRecovery ? "Recovery code" : "Authentication code"}
          name="code"
          autoComplete="one-time-code"
          inputMode={useRecovery ? "text" : "numeric"}
          required
          autoFocus
        />
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Verifying…" : "Verify and sign in"}
        </button>
        <div className="flex flex-col items-center gap-2 text-sm">
          <button type="button" className="text-brand hover:underline" onClick={() => setUseRecovery((v) => !v)}>
            {useRecovery ? "Use your authenticator app instead" : "Use a recovery code instead"}
          </button>
          <button type="button" className="text-ink-muted hover:underline" onClick={lostAccess}>
            Lost your authenticator and recovery codes?
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      {error && <Notice tone="error">{error}</Notice>}
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <p className="-mt-2 text-right text-xs">
        <a className="text-brand hover:underline" href="/forgot-password">Forgot password?</a>
      </p>
      <button className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-ink-muted">
        Looking for your security dashboard?{" "}
        <a className="text-brand hover:underline" href="/sso/open?target=portal&next=%2F">
          Open the Security Portal
        </a>
        <br />
        New to Secure360?{" "}
        <Link className="text-brand hover:underline" href="/signup">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

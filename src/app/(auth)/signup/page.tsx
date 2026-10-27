"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/client";
import { Field } from "@/components/Field";
import { Notice } from "@/components/ui";

/** Plan chosen on the pricing page is carried through signup to checkout. */
function planQuery(params: URLSearchParams): string | null {
  const plan = params.get("plan");
  const cycle = params.get("cycle");
  if (!plan || !/^[A-Z_]{2,40}$/.test(plan)) return null;
  return `plan=${plan}&cycle=${cycle === "ANNUAL" ? "ANNUAL" : "MONTHLY"}`;
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const chosen = planQuery(params);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      await api("/api/auth/signup", {
        body: { name: fd.get("name"), email: fd.get("email"), orgName: fd.get("orgName"), password: fd.get("password") },
      });
      window.location.assign(chosen ? `/checkout?${chosen}` : "/account?welcome=1");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <h1 className="text-xl font-semibold">Create your account</h1>
      {chosen && <Notice tone="info">Next you will review your {params.get("plan")?.toLowerCase()} plan and pay securely with Razorpay.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <Field label="Your name" name="name" autoComplete="name" required maxLength={100} />
      <Field label="Work email" name="email" type="email" autoComplete="email" required />
      <Field label="Company / organization" name="orgName" required maxLength={100} />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
        hint="At least 12 characters. A passphrase works well."
      />
      <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" required />
      <button className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Creating account…" : "Create account"}
      </button>
      <p className="text-center text-sm text-ink-muted">
        Already have an account?{" "}
        <Link className="text-brand hover:underline" href={chosen ? `/login?next=${encodeURIComponent(`/checkout?${chosen}`)}` : "/login"}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

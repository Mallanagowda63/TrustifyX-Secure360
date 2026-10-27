"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Field } from "@/components/Field";
import { Notice } from "@/components/ui";

interface Invite {
  email: string;
  role: string;
  orgName: string;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [me, setMe] = useState<{ user: { email: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<Invite>(`/api/invitations/${encodeURIComponent(token)}`),
      api<{ user: { email: string } }>("/api/auth/me").catch(() => null),
    ])
      .then(([inv, m]) => {
        setInvite(inv);
        setMe(m);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [token]);

  async function accept(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/invitations/accept", { body: { token, ...body } });
      // Continue into the Security Portal (signed in there via SSO).
      window.location.assign("/sso/open?target=portal&next=%2F");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (loading) return <div className="card p-6 text-sm text-ink-muted">Loading invitation…</div>;
  if (!invite) {
    return (
      <div className="card p-6">
        <Notice tone="error">{error ?? "Invitation not found"}</Notice>
      </div>
    );
  }

  return (
    <div className="card space-y-4 p-6">
      <h1 className="text-xl font-semibold">Join {invite.orgName}</h1>
      <p className="text-sm text-ink-muted">
        Invitation for <b className="text-ink">{invite.email}</b> as <b className="text-ink">{invite.role.toLowerCase()}</b>.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {me ? (
        <button className="btn btn-primary w-full" disabled={busy} onClick={() => accept({})}>
          Accept as {me.user.email}
        </button>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void accept({ name: fd.get("name"), password: fd.get("password") });
          }}
        >
          <Field label="Your name" name="name" required />
          <Field
            label="Choose a password"
            name="password"
            type="password"
            minLength={12}
            autoComplete="new-password"
            required
            hint="At least 12 characters."
          />
          <button className="btn btn-primary w-full" disabled={busy}>
            Create account &amp; join
          </button>
          <p className="text-center text-sm text-ink-muted">
            Already have an account?{" "}
            <Link className="text-brand hover:underline" href={`/login?next=/invite/${encodeURIComponent(token)}`}>
              Sign in first
            </Link>
          </p>
        </form>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Notice } from "@/components/ui";

export function AddWebsiteForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { website } = await api<{ website: { id: string } }>("/api/websites", {
        body: { url: fd.get("url"), displayName: fd.get("displayName") || undefined },
      });
      router.push(`/websites/${website.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_auto]">
        <label className="block">
          <span className="mb-1 block text-sm text-ink-muted">Website URL (HTTPS)</span>
          <input name="url" className="input" placeholder="https://www.example.com" required maxLength={2048} inputMode="url" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm text-ink-muted">Display name (optional)</span>
          <input name="displayName" className="input" placeholder="Main website" maxLength={100} />
        </label>
        <div className="flex items-end">
          <button className="btn btn-primary w-full md:w-auto" disabled={busy}>
            {busy ? "Adding…" : "Add website"}
          </button>
        </div>
      </div>
      <p className="text-xs text-ink-faint">
        Public HTTPS domains only. IP addresses, internal hostnames and non-standard ports are rejected. You will verify domain
        ownership on the next step.
      </p>
    </form>
  );
}

"use client";

import { useState } from "react";
import { api } from "@/lib/client";

/** Signs out of this website and the linked session on the other TrustifyX website. */
export function SignOutButton({ className, redirectTo, label = "Sign out" }: { className?: string; redirectTo: string; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        window.location.assign(redirectTo);
      }}
    >
      {busy ? "Signing out…" : label}
    </button>
  );
}

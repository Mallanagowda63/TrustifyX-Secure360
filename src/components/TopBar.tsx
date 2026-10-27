"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/client";

export function TopBar({
  user,
  org,
  role,
  orgs,
}: {
  user: { name: string; email: string };
  org: { id: string; name: string };
  role: string;
  orgs: Array<{ id: string; name: string; role: string }>;
}) {
  const router = useRouter();

  async function switchOrg(orgId: string) {
    await api("/api/auth/switch-org", { body: { orgId } });
    router.refresh();
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-navy-700 bg-navy-950/90 px-4 pl-14 backdrop-blur md:px-8">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {orgs.length > 1 ? (
          <select
            className="input max-w-56 py-1"
            value={org.id}
            onChange={(e) => void switchOrg(e.target.value)}
            aria-label="Switch organization"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate font-medium">{org.name}</span>
        )}
        <span className="rounded border border-navy-600 px-1.5 py-0.5 text-[11px] text-ink-muted uppercase">{role}</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <a href="/settings" className="hidden text-ink-muted hover:text-ink sm:inline" title={`Profile · ${user.email}`}>
          {user.name}
        </a>
        <button className="btn btn-ghost py-1" onClick={logout}>
          Sign out
        </button>
      </div>
    </header>
  );
}

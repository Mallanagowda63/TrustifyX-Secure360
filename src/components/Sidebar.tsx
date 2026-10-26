"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Logo } from "./Logo";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/websites", label: "Websites", icon: "◎" },
  { href: "/findings", label: "Findings", icon: "⚑" },
  { href: "/incidents", label: "Incidents & Alerts", icon: "⚠" },
  { href: "/reports", label: "Reports", icon: "▤" },
  { href: "/assistant", label: "AI Assistant", icon: "✦" },
  { href: "/integrations", label: "Integrations", icon: "⇄" },
  { href: "/billing", label: "Billing", icon: "₹" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function Sidebar({ canAudit, isPlatformAdmin = false }: { canAudit: boolean; isPlatformAdmin?: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const items = [
    ...NAV,
    ...(canAudit ? [{ href: "/audit", label: "Audit Log", icon: "☰" }] : []),
    ...(isPlatformAdmin ? [{ href: "/admin", label: "Platform Admin", icon: "◆" }] : []),
  ];

  return (
    <>
      <button
        className="fixed top-3 left-3 z-40 rounded-md border border-navy-600 bg-navy-900 px-2.5 py-1.5 text-sm md:hidden"
        onClick={() => setOpen((o) => !o)}
        aria-label="Toggle navigation"
      >
        ☰
      </button>
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-60 shrink-0 border-r border-navy-700 bg-navy-900 transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2 px-5 py-5 font-semibold">
          <Logo size={24} />
          <span>
            TrustifyX <span className="text-brand">Secure360</span>
          </span>
        </div>
        <nav className="space-y-0.5 px-3">
          {items.map((n) => {
            const active = path === n.href || path.startsWith(`${n.href}/`);
            return (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active ? "bg-brand-strong/20 font-semibold text-white" : "text-ink-muted hover:bg-navy-800 hover:text-ink"}`}
              >
                <span aria-hidden className="w-4 text-center">
                  {n.icon}
                </span>
                {n.label}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}

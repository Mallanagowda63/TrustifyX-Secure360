"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandMark } from "@/components/marketing/BrandMark";
import { Icon } from "@/components/marketing/Icon";
import { SignOutButton } from "@/components/SignOutButton";

const NAV = [
  { href: "/", label: "Dashboard", icon: "layout", match: ["/", "/dashboard"] },
  { href: "/websites", label: "My Websites", icon: "globe" },
  { href: "/check", label: "Check Website Security", icon: "shieldCheck" },
  { href: "/protection", label: "Firewall & Protection", icon: "shield" },
  { href: "/security-events", label: "Security Events", icon: "radar" },
  { href: "/scans", label: "Vulnerability Scanning", icon: "activity" },
  { href: "/servers", label: "Server Security", icon: "server" },
  { href: "/findings", label: "Security Findings", icon: "list" },
  { href: "/assistant", label: "AI Assistant", icon: "sparkles" },
  { href: "/incidents", label: "Alerts", icon: "bell" },
  { href: "/reports", label: "Reports", icon: "report" },
  { href: "/billing", label: "Billing Status", icon: "card" },
  { href: "/settings", label: "Settings", icon: "users" },
  { href: "/account-security", label: "Account Security", icon: "lock" },
];

export function PortalSidebar({ canAudit, isPlatformAdmin }: { canAudit: boolean; isPlatformAdmin: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const extra = [
    { href: "/integrations", label: "Integrations", icon: "link" },
    ...(canAudit ? [{ href: "/audit", label: "Audit Log", icon: "doc" }] : []),
    ...(isPlatformAdmin ? [{ href: "/admin", label: "Platform Admin", icon: "key" }] : []),
  ];
  const active = (item: { href: string; match?: string[] }) =>
    item.match ? item.match.includes(path) : path === item.href || path.startsWith(`${item.href}/`);

  const link = (n: { href: string; label: string; icon: string; match?: string[] }) => (
    <Link
      key={n.href}
      href={n.href}
      onClick={() => setOpen(false)}
      aria-current={active(n) ? "page" : undefined}
      className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${active(n) ? "bg-gradient-to-r from-royal-600/30 to-teal-500/10 font-semibold text-white ring-1 ring-royal-500/30" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}
    >
      <Icon name={n.icon} className={`h-[18px] w-[18px] ${active(n) ? "text-teal-300" : "text-slate-500 group-hover:text-slate-300"}`} />
      {n.label}
    </Link>
  );

  return (
    <>
      <button
        className="fixed top-3 left-3 z-40 rounded-md border border-white/10 bg-[#0a1428] p-2 text-white md:hidden"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
      >
        <Icon name={open ? "x" : "menu"} className="h-5 w-5" />
      </button>
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-64 shrink-0 flex-col border-r border-white/5 bg-[#070f22] transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2 px-5 py-5">
          <BrandMark className="h-8 w-8" />
          <div className="leading-tight">
            <div className="font-display text-[15px] font-bold text-white">TrustifyX Secure360</div>
            <div className="text-[10px] font-medium tracking-[0.18em] text-teal-300/80 uppercase">Security Portal</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Portal">
          {NAV.map(link)}
          <div className="px-3 pt-5 pb-1 text-[10px] font-semibold tracking-widest text-slate-600 uppercase">More</div>
          {extra.map(link)}
        </nav>
        <div className="border-t border-white/5 p-3">
          <SignOutButton
            redirectTo="/login"
            label="Logout"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white"
          />
        </div>
      </aside>
    </>
  );
}

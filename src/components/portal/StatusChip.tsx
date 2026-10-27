import type { SiteIndicator } from "@/server/services/portal";

const STYLE: Record<SiteIndicator, { label: string; cls: string; glyph: string }> = {
  WEBSITE_ONLINE: { label: "Website Online", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200", glyph: "●" },
  WEBSITE_OFFLINE: { label: "Website Offline", cls: "border-red-500/50 bg-red-500/15 text-red-200", glyph: "▼" },
  MONITORING_ACTIVE: { label: "Monitoring Active", cls: "border-teal-400/40 bg-teal-400/10 text-teal-200", glyph: "◉" },
  VERIFICATION_REQUIRED: { label: "Verification Required", cls: "border-amber-400/50 bg-amber-400/10 text-amber-200", glyph: "!" },
  SUBSCRIPTION_INACTIVE: { label: "Subscription Inactive", cls: "border-red-500/40 bg-red-500/10 text-red-200", glyph: "⨯" },
  INITIAL_SCAN_RUNNING: { label: "Initial Scan Running", cls: "border-sky-400/40 bg-sky-400/10 text-sky-200", glyph: "◌" },
  SECURITY_FINDING_DETECTED: { label: "Security Finding Detected", cls: "border-orange-400/40 bg-orange-400/10 text-orange-200", glyph: "▲" },
  MONITORING_PAUSED: { label: "Monitoring Paused", cls: "border-slate-400/40 bg-slate-400/10 text-slate-200", glyph: "❚❚" },
};

/** Status indicator: colour is always paired with a glyph and a text label. */
export function StatusChip({ indicator }: { indicator: SiteIndicator }) {
  const s = STYLE[indicator];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${s.cls}`}>
      <span aria-hidden className="text-[10px]">{s.glyph}</span>
      {s.label}
    </span>
  );
}

import type { ReactNode } from "react";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

// Status colours are reserved for severity/state and always paired with a glyph + label.
const SEVERITY_STYLE: Record<Severity, { color: string; glyph: string; label: string }> = {
  CRITICAL: { color: "#d03b3b", glyph: "◆", label: "Critical" },
  HIGH: { color: "#ec835a", glyph: "▲", label: "High" },
  MEDIUM: { color: "#fab219", glyph: "●", label: "Medium" },
  LOW: { color: "#86b6ef", glyph: "■", label: "Low" },
  INFO: { color: "#9fb0cc", glyph: "ℹ", label: "Info" },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ background: `color-mix(in oklab, ${s.color} 16%, transparent)`, color: "#e6edf8", border: `1px solid color-mix(in oklab, ${s.color} 55%, transparent)` }}
    >
      <span aria-hidden style={{ color: s.color }}>
        {s.glyph}
      </span>
      {s.label}
    </span>
  );
}

export const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
export const severityColor = (s: Severity) => SEVERITY_STYLE[s].color;

const WEBSITE_STATUS: Record<string, { label: string; cls: string }> = {
  PENDING_VERIFICATION: { label: "Pending Verification", cls: "border-amber-400/50 text-amber-200 bg-amber-400/10" },
  CONNECTED: { label: "Connected", cls: "border-emerald-500/50 text-emerald-200 bg-emerald-500/10" },
  MONITORING_PAUSED: { label: "Monitoring Paused", cls: "border-slate-400/50 text-slate-200 bg-slate-400/10" },
  VERIFICATION_FAILED: { label: "Verification Failed", cls: "border-red-500/50 text-red-200 bg-red-500/10" },
};

export function WebsiteStatusBadge({ status }: { status: string }) {
  const s = WEBSITE_STATUS[status] ?? { label: status, cls: "border-slate-500 text-slate-200" };
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${s.cls}`}>{s.label}</span>;
}

export function StateIndicator({ state, status }: { state: string; status?: string }) {
  if (status && status !== "CONNECTED") return <span className="text-sm text-ink-faint">— not monitored</span>;
  const map: Record<string, { color: string; label: string; glyph: string }> = {
    UP: { color: "#0ca30c", label: "Online", glyph: "●" },
    DOWN: { color: "#d03b3b", label: "Offline", glyph: "▼" },
    UNKNOWN: { color: "#6b7fa3", label: "Awaiting first check", glyph: "○" },
  };
  const s = map[state] ?? map.UNKNOWN;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span aria-hidden style={{ color: s.color }}>
        {s.glyph}
      </span>
      {s.label}
    </span>
  );
}

const FINDING_STATUS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
  FALSE_POSITIVE: "False Positive",
};
export function FindingStatusBadge({ status }: { status: string }) {
  const cls =
    status === "OPEN"
      ? "border-sky-400/50 text-sky-100"
      : status === "IN_PROGRESS"
        ? "border-violet-400/50 text-violet-100"
        : status === "RESOLVED"
          ? "border-emerald-500/50 text-emerald-100"
          : "border-slate-500/60 text-slate-300";
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs whitespace-nowrap ${cls}`}>{FINDING_STATUS[status] ?? status}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-navy-600 p-6 text-center text-sm text-ink-muted">{children}</div>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "success"; children: ReactNode }) {
  const cls = {
    info: "border-sky-500/40 bg-sky-500/10 text-sky-100",
    warn: "border-amber-400/40 bg-amber-400/10 text-amber-100",
    error: "border-red-500/40 bg-red-500/10 text-red-100",
    success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
  }[tone];
  return <div className={`rounded-lg border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}

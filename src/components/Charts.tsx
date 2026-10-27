"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface SeriesPoint {
  t: string;
  uptime: number | null;
  avgResponseMs: number | null;
  checks: number;
}

const SERIES = "#3987e5"; // validated against the navy chart surface (#0f1b33)
const GRID = "#1d2f55";
const AXIS = "#6b7fa3";

function fmtTick(t: string, span: "short" | "long") {
  const d = new Date(t);
  return span === "short"
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function TooltipBox({ active, payload, label, unit, span }: { active?: boolean; payload?: Array<{ value: number; payload: SeriesPoint }>; label?: string; unit: string; span: "short" | "long" }) {
  if (!active || !payload?.length || !label) return null;
  const p = payload[0];
  return (
    <div className="rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-xs shadow-lg">
      <div className="text-ink-muted">
        {new Date(label).toLocaleString("en-GB", { dateStyle: span === "long" ? "medium" : undefined, timeStyle: "short", timeZone: "UTC" })} UTC
      </div>
      <div className="mt-0.5 font-semibold text-ink tabular-nums">
        {p.value}
        {unit}
      </div>
      <div className="text-ink-faint">{p.payload.checks} checks</div>
    </div>
  );
}

function TableView({ points, value, unit }: { points: SeriesPoint[]; value: (p: SeriesPoint) => number | null; unit: string }) {
  return (
    <details className="mt-2 text-xs text-ink-muted">
      <summary className="cursor-pointer select-none">Table view</summary>
      <div className="mt-2 max-h-56 overflow-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Value</th>
              <th>Checks</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.t}>
                <td>{new Date(p.t).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className="tabular-nums">{value(p) ?? "—"}{value(p) !== null ? unit : ""}</td>
                <td className="tabular-nums">{p.checks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function NoData() {
  return (
    <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-navy-600 text-sm text-ink-muted">
      No monitoring data yet for this period.
    </div>
  );
}

export function UptimeChart({ points, span = "long" }: { points: SeriesPoint[]; span?: "short" | "long" }) {
  if (!points.length) return <NoData />;
  const min = Math.min(...points.map((p) => p.uptime ?? 100));
  // Zoom the axis so dips are visible, but always label it honestly.
  const floor = min >= 99 ? 95 : Math.max(0, Math.floor(min / 10) * 10);
  return (
    <div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <defs>
              <linearGradient id="uptimeFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES} stopOpacity={0.35} />
                <stop offset="100%" stopColor={SERIES} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" tickFormatter={(t) => fmtTick(t, span)} stroke={AXIS} fontSize={11} tickLine={false} minTickGap={28} />
            <YAxis domain={[floor, 100]} stroke={AXIS} fontSize={11} tickLine={false} unit="%" width={52} />
            <Tooltip content={<TooltipBox unit="%" span={span} />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
            <Area type="monotone" dataKey="uptime" stroke={SERIES} strokeWidth={2} fill="url(#uptimeFill)" connectNulls isAnimationActive={false} activeDot={{ r: 4, stroke: "#0f1b33", strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <TableView points={points} value={(p) => p.uptime} unit="%" />
    </div>
  );
}

export function ResponseTimeChart({ points, span = "short" }: { points: SeriesPoint[]; span?: "short" | "long" }) {
  const data = points.filter((p) => p.avgResponseMs !== null);
  if (!data.length) return <NoData />;
  return (
    <div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="t" tickFormatter={(t) => fmtTick(t, span)} stroke={AXIS} fontSize={11} tickLine={false} minTickGap={28} />
            <YAxis domain={[0, "auto"]} stroke={AXIS} fontSize={11} tickLine={false} unit=" ms" width={64} />
            <Tooltip content={<TooltipBox unit=" ms" span={span} />} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
            <Line type="monotone" dataKey="avgResponseMs" stroke={SERIES} strokeWidth={2} dot={false} isAnimationActive={false} activeDot={{ r: 4, stroke: "#0f1b33", strokeWidth: 2 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <TableView points={data} value={(p) => p.avgResponseMs} unit=" ms" />
    </div>
  );
}

// ─── Security events trend (stacked by action group) ───
// Categorical slots 1-3 of the reference palette, validated against the portal card surface #0a1428 (all checks pass).
const EVENT_SERIES = [
  { key: "blocked", label: "Blocked", color: "#3987e5" },
  { key: "challenged", label: "Challenged", color: "#d95926" },
  { key: "allowed", label: "Allowed / other", color: "#199e70" },
] as const;
const CARD_SURFACE = "#0a1428";

export interface EventTrendPoint {
  day: string;
  blocked: number;
  challenged: number;
  allowed: number;
  other: number;
}

function EventTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ dataKey: string; value: number }>; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-xs shadow-lg">
      <div className="text-ink-muted">{new Date(`${label}T00:00:00Z`).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" })} (UTC)</div>
      {EVENT_SERIES.map((s) => {
        const v = payload.find((p) => p.dataKey === s.key)?.value ?? 0;
        return (
          <div key={s.key} className="mt-0.5 flex items-center gap-2 text-ink">
            <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
            <span className="text-ink-muted">{s.label}</span>
            <span className="ml-auto font-semibold tabular-nums">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Daily security events by action group. Counts are events, not unique attackers. */
export function EventsTrendChart({ points }: { points: EventTrendPoint[] }) {
  const data = points.map((p) => ({ ...p, allowed: p.allowed + p.other }));
  if (!data.some((p) => p.blocked + p.challenged + p.allowed > 0)) {
    return <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-navy-600 text-sm text-ink-muted">No security events imported for this period.</div>;
  }
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-4 text-xs text-ink-muted" aria-label="Legend">
        {EVENT_SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barCategoryGap="30%">
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="day" tickFormatter={(d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })} stroke={AXIS} fontSize={11} tickLine={false} minTickGap={20} />
            <YAxis allowDecimals={false} stroke={AXIS} fontSize={11} tickLine={false} width={48} />
            <Tooltip content={<EventTooltip />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
            {EVENT_SERIES.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="events"
                fill={s.color}
                stroke={CARD_SURFACE}
                strokeWidth={2}
                radius={i === EVENT_SERIES.length - 1 ? [4, 4, 0, 0] : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-xs text-ink-muted">
        <summary className="cursor-pointer select-none">Table view</summary>
        <div className="mt-2 max-h-56 overflow-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Day (UTC)</th>
                {EVENT_SERIES.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.day}>
                  <td>{p.day}</td>
                  <td className="tabular-nums">{p.blocked}</td>
                  <td className="tabular-nums">{p.challenged}</td>
                  <td className="tabular-nums">{p.allowed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

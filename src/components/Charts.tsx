"use client";

import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

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

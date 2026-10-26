"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { ResponseTimeChart, UptimeChart, type SeriesPoint } from "@/components/Charts";

type Range = "24h" | "7d" | "30d";
interface Series {
  range: Range;
  uptimePercent: number | null;
  checks: number;
  points: SeriesPoint[];
}

export function SeriesPanel({ websiteId, initial }: { websiteId: string; initial: Series }) {
  const [series, setSeries] = useState<Series>(initial);
  const [loading, setLoading] = useState(false);

  async function load(range: Range) {
    setLoading(true);
    try {
      setSeries(await api<Series>(`/api/websites/${websiteId}/series?range=${range}`));
    } finally {
      setLoading(false);
    }
  }

  const span = series.range === "24h" ? "short" : "long";
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Availability</h2>
          <p className="text-sm text-ink-muted">
            {series.uptimePercent !== null ? `${series.uptimePercent}% uptime` : "No data"} · {series.checks} checks
            {loading ? " · loading…" : ""}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Time range">
          {(["24h", "7d", "30d"] as const).map((r) => (
            <button key={r} className={`btn py-1 ${series.range === r ? "btn-primary" : "btn-ghost"}`} onClick={() => load(r)} disabled={loading}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-2 text-sm text-ink-muted">Uptime</div>
          <UptimeChart points={series.points} span={span} />
        </div>
        <div className="min-w-0">
          <div className="mb-2 text-sm text-ink-muted">Average response time</div>
          <ResponseTimeChart points={series.points} span={span} />
        </div>
      </div>
    </section>
  );
}

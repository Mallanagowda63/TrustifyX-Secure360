import type { SeriesPoint } from "@/components/Charts";

/**
 * DEMONSTRATION DATA. Rendered only when an organization has no websites yet, always
 * under a "Demonstration data" banner. It is static, never stored, and never mixed with real results.
 */
export function demoDashboard() {
  const now = Date.now();
  const uptime: SeriesPoint[] = Array.from({ length: 30 }, (_, i) => ({
    t: new Date(now - (29 - i) * 86_400_000).toISOString(),
    uptime: i === 18 ? 97.9 : i === 7 ? 99.3 : 100,
    avgResponseMs: 280 + ((i * 37) % 90),
    checks: 288,
  }));
  const response: SeriesPoint[] = Array.from({ length: 24 }, (_, i) => ({
    t: new Date(now - (23 - i) * 3600_000).toISOString(),
    uptime: 100,
    avgResponseMs: 240 + ((i * 53) % 140),
    checks: 12,
  }));
  return {
    totals: { websites: 2, connected: 2, online: 2, offline: 0, pending: 0, latestCheckAt: new Date(now - 120_000) },
    severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 3, INFO: 2 },
    uptime,
    response,
  };
}

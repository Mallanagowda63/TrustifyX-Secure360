import Link from "next/link";
import { requirePageSession } from "@/server/auth/page";
import { prisma } from "@/server/db";
import { eventSummary, type EventCoverage } from "@/server/protection/events";
import { protectionAccess } from "@/server/protection/service";
import { idSchema } from "@/server/validation";
import { EventsTrendChart } from "@/components/Charts";
import { Empty, Notice, PageHeader, Section } from "@/components/ui";

export const dynamic = "force-dynamic";

const DAY_OPTIONS = [1, 7, 30];

function coverageText(c: EventCoverage | null) {
  if (!c) return "Not synchronised yet.";
  if (!c.enabled) return "Security event data unavailable for the connected Cloudflare plan or permissions.";
  const days = c.notOlderThan ? Math.floor(c.notOlderThan / 86400) : null;
  return `Cloudflare lets this account read security events from the last ${days ?? "?"} days. Fields available: ${c.fields.length}.`;
}

export default async function SecurityEventsPage({ searchParams }: { searchParams: Promise<{ zone?: string; days?: string }> }) {
  const s = await requirePageSession("protection.read");
  const sp = await searchParams;
  const access = await protectionAccess(s.org.id);
  const zone = sp.zone && idSchema.safeParse(sp.zone).success ? sp.zone : undefined;
  const days = DAY_OPTIONS.includes(Number(sp.days)) ? Number(sp.days) : 7;

  if (!access.protect) {
    return (
      <div>
        <PageHeader title="Security Events" />
        <Notice tone="info">
          Unavailable on Current Plan. Real Cloudflare security events are part of the Secure360 Protect add-on.{" "}
          <Link className="underline" href="/protection">Firewall & Protection</Link>
        </Notice>
      </div>
    );
  }

  const [data, allZones] = await Promise.all([
    eventSummary(s.org.id, { zoneRefId: zone, days }),
    prisma.cloudflareZone.findMany({ where: { orgId: s.org.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const qs = (o: { zone?: string; days?: number }) => {
    const p = new URLSearchParams();
    if (o.zone ?? zone) p.set("zone", (o.zone ?? zone)!);
    p.set("days", String(o.days ?? days));
    return `?${p.toString()}`;
  };
  const requests = data.zones.length === 1 ? data.zones[0].coverage?.requests24h : undefined;

  return (
    <div className="space-y-6">
      <PageHeader title="Security Events" subtitle="Imported from Cloudflare. Counts are security events, not unique attackers or attacks." />

      <div className="flex flex-wrap items-center gap-2">
        <Link className={`btn ${!zone ? "btn-primary" : ""}`} href={`?days=${days}`}>All zones</Link>
        {allZones.map((z) => (
          <Link key={z.id} className={`btn ${zone === z.id ? "btn-primary" : ""}`} href={qs({ zone: z.id })}>{z.name}</Link>
        ))}
        <span className="mx-2 h-6 w-px bg-white/10" />
        {DAY_OPTIONS.map((d) => (
          <Link key={d} className={`btn ${days === d ? "btn-primary" : ""}`} href={qs({ days: d })}>{d === 1 ? "24 hours" : `${d} days`}</Link>
        ))}
      </div>

      {data.zones.length === 0 ? (
        <Empty>
          No Cloudflare zone is linked yet. <Link className="text-royal-300 hover:underline" href="/protection">Connect Cloudflare</Link>
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Blocked" value={data.totals.blocked} hint="Events with a block action" />
            <Stat label="Challenged" value={data.totals.challenged} hint="Managed / JS / interactive challenges" />
            <Stat label="Allowed / skipped" value={data.totals.allowed + data.totals.other} hint="Where Cloudflare reports them" />
            <Stat
              label="Requests evaluated (24h)"
              value={requests === undefined ? "Select a zone" : requests === null ? "Unavailable" : requests.toLocaleString()}
              hint={requests === null ? "Not available for this plan or token" : "Cloudflare HTTP requests, last 24 hours"}
            />
          </div>

          <Section title={`Security events trend · last ${days === 1 ? "24 hours" : `${days} days`}`}>
            <EventsTrendChart points={data.trend} />
          </Section>

          <div className="grid gap-6 lg:grid-cols-3">
            <Section title="Top source countries">
              {data.topCountries.length === 0 ? (
                <Empty>No country data.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {data.topCountries.map((c) => (
                    <li key={c.country} className="flex justify-between">
                      <span>{c.country}</span>
                      <span className="tabular-nums text-ink-muted">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <div className="min-w-0 lg:col-span-2">
              <Section title="Events by action">
                {data.byAction.length === 0 ? (
                  <Empty>No events in this period.</Empty>
                ) : (
                  <ul className="grid gap-2 text-sm sm:grid-cols-2">
                    {data.byAction.map((a) => (
                      <li key={a.action} className="flex justify-between rounded-md border border-navy-600 px-3 py-2">
                        <span className="font-mono text-xs">{a.action}</span>
                        <span className="tabular-nums">{a.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>
          </div>

          <Section title="Recent security events">
            {data.recent.length === 0 ? (
              <Empty>No security events have been imported for this period.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="data min-w-[720px]">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Rule</th>
                      <th>Request</th>
                      <th>Country</th>
                      <th>Ray ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((e) => (
                      <tr key={e.id}>
                        <td className="whitespace-nowrap">{new Date(e.occurredAt).toLocaleString()}</td>
                        <td className="font-mono text-xs">{e.action}</td>
                        <td className="text-xs">
                          {e.source ?? "—"}
                          {e.ruleId && <span className="block max-w-[10rem] truncate font-mono text-ink-faint" title={e.ruleId}>{e.ruleId}</span>}
                        </td>
                        <td className="max-w-xs truncate text-xs" title={`${e.method ?? ""} ${e.host ?? e.zone.name}${e.path ?? ""}`}>
                          {e.method ? `${e.method} ` : ""}
                          {e.host ?? e.zone.name}
                          {e.path ?? ""}
                        </td>
                        <td>{e.country ?? "—"}</td>
                        <td className="font-mono text-xs">{e.rayId ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Data coverage">
            <ul className="space-y-2 text-sm">
              {data.zones.map((z) => (
                <li key={z.id}>
                  <span className="font-medium">{z.name}:</span> <span className="text-ink-muted">{coverageText(z.coverage)}</span>{" "}
                  <span className="text-ink-faint">Imported up to {z.syncedUntil ? new Date(z.syncedUntil).toLocaleString() : "not yet"}.</span>
                  {z.error && z.error !== "unavailable" && <span className="block text-amber-200">{z.error}</span>}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
      <div className="text-xs font-semibold tracking-wide text-slate-400 uppercase">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-white">{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="mt-1 text-xs text-slate-500">{hint}</div>
    </div>
  );
}

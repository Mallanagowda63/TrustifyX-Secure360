"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { Empty, Notice, Section } from "@/components/ui";
import { activeAuthorizationText, passiveAuthorizationText } from "@/server/scanning/authorization";

interface Scan {
  id: string;
  type: "PASSIVE" | "ACTIVE";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  trigger: string;
  progress: number;
  message: string | null;
  error: string | null;
  alertCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  website: { id: string; hostname: string };
}

interface Data {
  scans: Scan[];
  schedules: Array<{ websiteId: string; frequency: string; nextRunAt: string; lastRunAt: string | null; enabled: boolean }>;
  websites: Array<{ id: string; hostname: string; displayName: string }>;
  usage: { plan: string | null; active: boolean; quota: { passive: number; active: number }; used: { passive: number; active: number } };
}

const STATUS: Record<Scan["status"], { text: string; cls: string; glyph: string }> = {
  QUEUED: { text: "Queued", cls: "border-sky-400/40 text-sky-200", glyph: "◌" },
  RUNNING: { text: "Running", cls: "border-teal-400/50 bg-teal-400/10 text-teal-200", glyph: "◉" },
  COMPLETED: { text: "Completed", cls: "border-emerald-500/50 text-emerald-200", glyph: "●" },
  FAILED: { text: "Failed", cls: "border-red-500/50 text-red-200", glyph: "⨯" },
  CANCELLED: { text: "Cancelled", cls: "border-slate-500/50 text-slate-300", glyph: "–" },
};

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ScansView({ initial, canManage }: { initial: Data; canManage: boolean }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [websiteId, setWebsiteId] = useState(initial.websites[0]?.id ?? "");
  const [type, setType] = useState<"PASSIVE" | "ACTIVE">("PASSIVE");
  const [agree, setAgree] = useState(false);
  const [typedHost, setTypedHost] = useState("");
  const [start, setStart] = useState(() => localInput(new Date(Date.now() + 3600_000)));
  const [hours, setHours] = useState(2);

  const website = data.websites.find((w) => w.id === websiteId);
  const windowStart = useMemo(() => new Date(start), [start]);
  const windowEnd = useMemo(() => new Date(windowStart.getTime() + hours * 3600_000), [windowStart, hours]);
  const statement = website ? (type === "ACTIVE" ? activeAuthorizationText(website.hostname, windowStart, windowEnd) : passiveAuthorizationText(website.hostname)) : "";
  const activeAllowed = data.usage.quota.active > 0;
  const running = data.scans.some((s) => s.status === "QUEUED" || s.status === "RUNNING");

  const reload = async () => setData(await api<Data>("/api/scans"));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload().catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, [running]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
          <div className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Passive scans this month</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">
            {data.usage.used.passive} <span className="text-base text-slate-400">of {data.usage.quota.passive}</span>
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-[#0a1428] p-4">
          <div className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Active scans this month</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">
            {activeAllowed ? (
              <>
                {data.usage.used.active} <span className="text-base text-slate-400">of {data.usage.quota.active}</span>
              </>
            ) : (
              <span className="text-base text-slate-300">Unavailable on Current Plan</span>
            )}
          </div>
        </div>
      </div>

      {!data.usage.active ? (
        <Notice tone="warn">An active Secure360 plan is required to run security scans.</Notice>
      ) : data.websites.length === 0 ? (
        <Empty>
          Verify a website first. Scans only run against websites whose ownership you have proven.{" "}
          <Link className="text-royal-300 hover:underline" href="/check">Check Your Website Security</Link>
        </Empty>
      ) : canManage ? (
        <Section title="New scan">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/api/scans", {
                  body: {
                    websiteId,
                    type,
                    confirmAuthorization: agree,
                    ...(type === "ACTIVE" ? { confirmHostname: typedHost, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() } : {}),
                  },
                });
                setAgree(false);
                setTypedHost("");
                setNotice(type === "ACTIVE" ? "Active scan scheduled for your maintenance window." : "Passive scan queued. Progress updates appear below.");
                await reload();
              });
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Verified website</span>
                <select className="input" value={websiteId} onChange={(e) => { setWebsiteId(e.target.value); setAgree(false); }}>
                  {data.websites.map((w) => (
                    <option key={w.id} value={w.id}>{w.displayName} ({w.hostname})</option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend className="mb-1 block text-sm font-medium">Scan type</legend>
                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-start gap-2">
                    <input type="radio" name="type" className="mt-1" checked={type === "PASSIVE"} onChange={() => { setType("PASSIVE"); setAgree(false); }} />
                    <span><span className="font-medium">Passive baseline</span> <span className="text-ink-muted">· crawls public pages and analyses responses. No attack payloads.</span></span>
                  </label>
                  <label className={`flex items-start gap-2 ${activeAllowed ? "" : "opacity-50"}`}>
                    <input type="radio" name="type" className="mt-1" disabled={!activeAllowed} checked={type === "ACTIVE"} onChange={() => { setType("ACTIVE"); setAgree(false); }} />
                    <span>
                      <span className="font-medium">Active scan</span> <span className="text-ink-muted">· sends test inputs (e.g. injection checks) during a maintenance window. {activeAllowed ? "" : "Business plan only."}</span>
                    </span>
                  </label>
                </div>
              </fieldset>
            </div>

            {type === "ACTIVE" && website && (
              <div className="grid gap-4 rounded-lg border border-amber-400/40 bg-amber-400/5 p-4 md:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Window starts</span>
                  <input type="datetime-local" className="input" value={start} onChange={(e) => { setStart(e.target.value); setAgree(false); }} required />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Duration</span>
                  <select className="input" value={hours} onChange={(e) => { setHours(Number(e.target.value)); setAgree(false); }}>
                    {[1, 2, 3, 4].map((h) => <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Type the hostname to confirm</span>
                  <input className="input font-mono" value={typedHost} onChange={(e) => setTypedHost(e.target.value)} placeholder={website.hostname} autoComplete="off" required />
                </label>
                <p className="text-xs text-amber-100 md:col-span-3">
                  Active scans can create test data, trigger alerts in your systems and slow the site down. Destructive, brute-force and denial-of-service tests are
                  never run. Take a backup first and tell your hosting provider if required.
                </p>
              </div>
            )}

            {website && (
              <label className="flex items-start gap-3 rounded-lg border border-navy-600 p-3 text-sm">
                <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                <span className="text-ink-muted">{statement}</span>
              </label>
            )}
            <button className="btn btn-primary" disabled={busy || !agree || running}>
              {busy ? "Submitting…" : type === "ACTIVE" ? "Authorize and schedule active scan" : "Authorize and start passive scan"}
            </button>
            {running && <span className="ml-3 text-xs text-ink-faint">A scan is already queued or running for your organization.</span>}
          </form>
        </Section>
      ) : (
        <Notice tone="info">Only owners and admins can authorize scans.</Notice>
      )}

      <Section title="Scan history">
        {data.scans.length === 0 ? (
          <Empty>No scans yet.</Empty>
        ) : (
          <ul className="divide-y divide-white/5">
            {data.scans.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
                <div className="min-w-0 flex-1 basis-56">
                  <span className="font-medium">{s.website.hostname}</span>{" "}
                  <span className="text-xs text-ink-faint">{s.type === "ACTIVE" ? "Active" : "Passive"} · {s.trigger === "SCHEDULED" ? "scheduled" : "manual"} · {new Date(s.createdAt).toLocaleString()}</span>
                  {s.windowStart && <span className="block text-xs text-ink-faint">Window {new Date(s.windowStart).toLocaleString()} – {s.windowEnd ? new Date(s.windowEnd).toLocaleTimeString() : ""}</span>}
                  {s.error && <span className="block text-xs text-red-300">{s.error}</span>}
                </div>
                <div className="basis-48">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS[s.status].cls}`}>
                    <span aria-hidden>{STATUS[s.status].glyph}</span> {STATUS[s.status].text}
                  </span>
                  {(s.status === "RUNNING" || s.status === "QUEUED") && (
                    <div className="mt-1.5">
                      <div className="h-1.5 w-40 rounded-full bg-white/10" role="progressbar" aria-valuenow={s.progress} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-1.5 rounded-full bg-teal-400" style={{ width: `${s.progress}%` }} />
                      </div>
                      <span className="text-xs text-ink-faint">{s.message}</span>
                    </div>
                  )}
                  {s.status === "COMPLETED" && <span className="mt-1 block text-xs text-ink-muted">{s.alertCount} alert type{s.alertCount === 1 ? "" : "s"}</span>}
                </div>
                <div className="ml-auto flex gap-2">
                  {s.status === "COMPLETED" && <Link className="btn py-1" href={`/scans/${s.id}`}>View results</Link>}
                  {canManage && (s.status === "RUNNING" || s.status === "QUEUED") && (
                    <button className="btn py-1" disabled={busy} onClick={() => run(async () => { await api(`/api/scans/${s.id}/cancel`, { body: {} }); await reload(); })}>Cancel</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canManage && data.websites.length > 0 && data.usage.active && (
        <Section title="Scheduled passive scans">
          <ul className="divide-y divide-white/5 text-sm">
            {data.websites.map((w) => (
              <ScheduleRow key={w.id} website={w} schedule={data.schedules.find((s) => s.websiteId === w.id)} busy={busy} onSave={(frequency, confirm) => run(async () => {
                await api("/api/scans/schedules", { body: { websiteId: w.id, frequency, confirmAuthorization: confirm } });
                await reload();
                setNotice(frequency === "OFF" ? `Scheduled scans for ${w.hostname} turned off.` : `${w.hostname} will be scanned ${frequency.toLowerCase()}.`);
              })} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ScheduleRow({ website, schedule, busy, onSave }: { website: { id: string; hostname: string }; schedule?: { frequency: string; nextRunAt: string }; busy: boolean; onSave: (f: "WEEKLY" | "MONTHLY" | "OFF", confirm: boolean) => void }) {
  const [freq, setFreq] = useState<"WEEKLY" | "MONTHLY" | "OFF">((schedule?.frequency as "WEEKLY" | "MONTHLY") ?? "OFF");
  const [agree, setAgree] = useState(false);
  const changed = freq !== (schedule?.frequency ?? "OFF");
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="min-w-0 flex-1 basis-48">
        {website.hostname}
        {schedule && <span className="block text-xs text-ink-faint">Next run {new Date(schedule.nextRunAt).toLocaleDateString()}</span>}
      </span>
      <select className="input w-auto py-1.5" value={freq} onChange={(e) => { setFreq(e.target.value as "WEEKLY" | "MONTHLY" | "OFF"); setAgree(false); }}>
        <option value="OFF">Off</option>
        <option value="WEEKLY">Weekly</option>
        <option value="MONTHLY">Monthly</option>
      </select>
      {changed && freq !== "OFF" && (
        <label className="flex basis-full items-start gap-2 text-xs text-ink-muted">
          <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          {passiveAuthorizationText(website.hostname)} This authorization covers recurring {freq.toLowerCase()} passive scans until I turn the schedule off.
        </label>
      )}
      {changed && (
        <button className="btn py-1" disabled={busy || (freq !== "OFF" && !agree)} onClick={() => onSave(freq, agree)}>Save</button>
      )}
    </li>
  );
}

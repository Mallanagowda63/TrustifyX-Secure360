"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { Empty, Notice, Section } from "@/components/ui";

type Availability = "AVAILABLE" | "UNAVAILABLE_PLAN" | "MISSING_PERMISSION" | "SETUP_REQUIRED";
type State = "ENABLED" | "ENABLED_OUTSIDE_TRUSTIFYX" | "PREVIEW" | "NOT_ENABLED" | "UNKNOWN";

interface Feature {
  key: string;
  label: string;
  description: string;
  caution: string | null;
  kind: string;
  availability: Availability;
  reason?: string;
  state: State;
  managedByTrustifyX: boolean;
  verifiedAt: string | null;
  lastError: string | null;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  plan: string | null;
  nameServers: string[] | null;
  website: { id: string; hostname: string; displayName: string };
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  capabilities: { plan: string; customRuleLimit: number; customRulesUsed: number | null } | null;
  settings: Record<string, unknown> | null;
  dns: { proxied: boolean | null; exposedRecords: string[] } | null;
  customRules: Array<{ id: string | null; description: string; action: string; enabled: boolean; trustifyx: boolean }> | null;
  ddos: { edgeProtected: boolean; summary: string; warnings: string[] };
  eventsSyncedUntil: string | null;
  eventsError: string | null;
  features: Feature[];
}

interface Overview {
  access: { protect: boolean; baseActive: boolean };
  connection: { status: string; tokenHint: string; tokenExpiresAt: string | null; lastVerifiedAt: string | null; lastError: string | null } | null;
  verifiedWebsites: number;
  zones: Zone[];
  changes: Array<{ id: string; createdAt: string; feature: string; action: string; result: string; error: string | null }>;
}

interface Discover {
  zones: Array<{ id: string; name: string; status: string; plan: string | null }>;
  websites: Array<{ id: string; hostname: string; displayName: string; linkedZone: { id: string; name: string } | null; candidates: string[] }>;
}

interface Planned {
  zone: { name: string; website: string };
  mode: "enforce" | "preview";
  changes: Array<{ key: string; label: string; applicable: boolean; reason?: string; caution?: string; before: unknown; after: unknown }>;
  fingerprint: string;
}

const AVAIL: Record<Availability, { text: string; cls: string }> = {
  AVAILABLE: { text: "Available", cls: "border-sky-400/40 text-sky-200" },
  UNAVAILABLE_PLAN: { text: "Unavailable on Current Plan", cls: "border-slate-500/50 text-slate-300" },
  MISSING_PERMISSION: { text: "Token Permission Missing", cls: "border-amber-400/50 text-amber-200" },
  SETUP_REQUIRED: { text: "Setup Required", cls: "border-amber-400/50 text-amber-200" },
};
const STATE: Record<State, { text: string; cls: string; glyph: string }> = {
  ENABLED: { text: "Active (TrustifyX)", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-200", glyph: "●" },
  ENABLED_OUTSIDE_TRUSTIFYX: { text: "Active (set in Cloudflare)", cls: "border-emerald-500/40 text-emerald-200", glyph: "●" },
  PREVIEW: { text: "Preview: not enforcing", cls: "border-sky-400/50 bg-sky-500/10 text-sky-200", glyph: "◌" },
  NOT_ENABLED: { text: "Not enabled", cls: "border-slate-500/50 text-slate-300", glyph: "○" },
  UNKNOWN: { text: "Unknown", cls: "border-slate-600 text-slate-400", glyph: "?" },
};

const fmt = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
const when = (d: string | null) => (d ? new Date(d).toLocaleString() : "never");

function Pill({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>{children}</span>;
}

export function ProtectionView({ initial, canManage }: { initial: Overview; canManage: boolean }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discover, setDiscover] = useState<Discover | null>(null);
  const [showConnect, setShowConnect] = useState(!initial.connection);

  const reload = async () => setData(await api<Overview>("/api/protection"));
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

  if (!data.access.baseActive) {
    return <Notice tone="warn">An active Secure360 subscription is required before website protection can be set up.</Notice>;
  }

  return (
    <div className="space-y-6">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice tone="success">{notice}</Notice>}

      {!data.access.protect && (
        <section className="card border-sky-500/30 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <Pill cls="border-slate-500/50 text-slate-300">Unavailable on Current Plan</Pill>
              <h2 className="mt-3 text-lg font-semibold">Secure360 Protect add-on</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Connect your own Cloudflare account and let TrustifyX apply reviewed protection settings and firewall rules, with real Cloudflare security events
                and a full change history. Cloudflare charges for paid Cloudflare plans, if any, are billed by Cloudflare separately.
              </p>
            </div>
            <a className="btn btn-primary" href="/sso/open?target=marketing&next=%2Faccount%2Fbilling">View Protect add-on</a>
          </div>
        </section>
      )}

      <Section
        title="Cloudflare connection"
        actions={
          data.connection && canManage && data.access.protect ? (
            <div className="flex gap-2">
              <button className="btn" onClick={() => setShowConnect((v) => !v)}>Replace token</button>
              <DisconnectButton busy={busy} onConfirm={(remove) => run(async () => {
                const r = await api<{ failures: string[] }>("/api/protection/disconnect", { body: { removeTrustifyxChanges: remove, confirm: true } });
                setNotice(r.failures.length ? `Disconnected. Some TrustifyX changes could not be removed: ${r.failures.join("; ")}` : "Cloudflare disconnected. The stored token was deleted.");
                setDiscover(null);
                await reload();
                setShowConnect(true);
              })} />
            </div>
          ) : null
        }
      >
        {data.connection ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {data.connection.status === "ACTIVE" ? (
              <Pill cls="border-emerald-500/50 bg-emerald-500/10 text-emerald-200">● Connected</Pill>
            ) : (
              <Pill cls="border-red-500/50 bg-red-500/10 text-red-200">⨯ Token not accepted</Pill>
            )}
            <span className="text-ink-muted">API token ending ····{data.connection.tokenHint}</span>
            <span className="text-ink-faint">Last verified {when(data.connection.lastVerifiedAt)}</span>
            {data.connection.tokenExpiresAt && <span className="text-ink-faint">Token expires {new Date(data.connection.tokenExpiresAt).toLocaleDateString()}</span>}
            {data.connection.lastError && <span className="w-full text-red-300">{data.connection.lastError}</span>}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            <Pill cls="border-slate-500/50 text-slate-300">Not Connected</Pill>
          </p>
        )}

        {showConnect && canManage && data.access.protect && (
          <form
            className="mt-4 grid gap-4 rounded-lg border border-navy-600 p-4 lg:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const token = String(new FormData(e.currentTarget).get("token") ?? "");
              const form = e.currentTarget;
              void run(async () => {
                const d = await api<Discover>("/api/protection/connect", { body: { token } });
                form.reset();
                setDiscover(d);
                setShowConnect(false);
                setNotice("Cloudflare connected. The token was verified and stored encrypted. Nothing was changed in Cloudflare.");
                await reload();
              });
            }}
          >
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Cloudflare API token</span>
                <input name="token" type="password" autoComplete="off" required minLength={20} className="input font-mono" placeholder="Paste a scoped API token" />
              </label>
              <p className="text-xs text-ink-faint">
                Never paste your Cloudflare password or Global API Key. The token is verified with Cloudflare, encrypted at rest, and never shown again.
              </p>
              <button className="btn btn-primary" disabled={busy}>{busy ? "Verifying with Cloudflare…" : "Connect Cloudflare"}</button>
            </div>
            <div className="text-sm text-ink-muted">
              <p className="font-medium text-ink">Create a token in Cloudflare → My Profile → API Tokens → Create Custom Token, for your zone only:</p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                <li>Zone → Zone → Read</li>
                <li>Zone → DNS → Read</li>
                <li>Zone → Zone Settings → Edit</li>
                <li>Zone → Zone WAF → Edit</li>
                <li>Zone → Bot Management → Edit (Free plans, optional)</li>
                <li>Zone → Analytics → Read (security events)</li>
              </ul>
              <p className="mt-2 text-xs text-ink-faint">Read-only tokens also work: you will see status and events, and changes will show the missing permission.</p>
            </div>
          </form>
        )}
      </Section>

      {data.connection && data.access.protect && (
        <Section
          title="Websites and Cloudflare zones"
          actions={<button className="btn" disabled={busy} onClick={() => run(async () => setDiscover(await api<Discover>("/api/protection/zones/discover")))}>Find zones</button>}
        >
          {data.verifiedWebsites === 0 ? (
            <Empty>
              Verify a website first. <Link className="text-royal-300 hover:underline" href="/check">Check Your Website Security</Link>
            </Empty>
          ) : !discover ? (
            <p className="text-sm text-ink-muted">Use Find zones to match your verified websites with the zones in your Cloudflare account.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data min-w-[560px]">
                <thead>
                  <tr>
                    <th>Website</th>
                    <th>Cloudflare zone</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {discover.websites.map((w) => (
                    <ZoneLinkRow
                      key={w.id}
                      website={w}
                      zones={discover.zones}
                      disabled={busy || !canManage}
                      onLink={(cfZoneId) => run(async () => {
                        await api("/api/protection/zones", { body: { websiteId: w.id, cfZoneId } });
                        setDiscover(await api<Discover>("/api/protection/zones/discover"));
                        await reload();
                        setNotice(`Linked ${w.hostname}. Configuration read from Cloudflare (nothing was changed).`);
                      })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {data.zones.map((z) => (
        <ZoneCard key={z.id} zone={z} canManage={canManage && data.access.protect} busy={busy} run={run} reload={reload} setNotice={setNotice} />
      ))}

      <Section title="Configuration change history">
        {data.changes.length === 0 ? (
          <Empty>No protection changes yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data min-w-[560px]">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Change</th>
                  <th>Feature</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.changes.map((c) => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap">{new Date(c.createdAt).toLocaleString()}</td>
                    <td>{c.action.replace(/_/g, " ").toLowerCase()}</td>
                    <td>{c.feature}</td>
                    <td>
                      <span className={c.result === "SUCCEEDED" ? "text-emerald-300" : "text-red-300"}>{c.result === "SUCCEEDED" ? "✓ Verified" : c.result === "VERIFY_FAILED" ? "⨯ Not verified" : "⨯ Failed"}</span>
                      {c.error && <span className="block max-w-md truncate text-xs text-ink-faint" title={c.error}>{c.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function ZoneLinkRow({ website, zones, disabled, onLink }: { website: Discover["websites"][number]; zones: Discover["zones"]; disabled: boolean; onLink: (id: string) => void }) {
  const [choice, setChoice] = useState(website.candidates[0] ?? "");
  return (
    <tr>
      <td>
        {website.displayName}
        <span className="block text-xs text-ink-faint">{website.hostname}</span>
      </td>
      <td>
        {website.linkedZone ? (
          <span className="text-emerald-300">● {website.linkedZone.name}</span>
        ) : website.candidates.length ? (
          <select className="input py-1.5" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {website.candidates.map((id) => {
              const z = zones.find((x) => x.id === id)!;
              return (
                <option key={id} value={id}>
                  {z.name} ({z.status}, {z.plan ?? "plan unknown"})
                </option>
              );
            })}
          </select>
        ) : (
          <span className="text-ink-muted">No zone in this Cloudflare account serves this hostname.</span>
        )}
      </td>
      <td className="text-right">
        {!website.linkedZone && website.candidates.length > 0 && (
          <button className="btn btn-primary py-1.5" disabled={disabled} onClick={() => onLink(choice)}>Link zone</button>
        )}
      </td>
    </tr>
  );
}

function DisconnectButton({ busy, onConfirm }: { busy: boolean; onConfirm: (removeChanges: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState(true);
  if (!open) return <button className="btn btn-danger" onClick={() => setOpen(true)}>Disconnect Integration</button>;
  return (
    <div role="dialog" aria-modal="true" aria-label="Disconnect Cloudflare" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
    <div className="w-full max-w-sm rounded-lg border border-navy-600 bg-navy-900 p-5 text-sm shadow-xl">
      <p className="font-medium">Disconnect Cloudflare?</p>
      <p className="mt-1 text-ink-muted">The stored token, linked zones and imported events are deleted from Secure360.</p>
      <label className="mt-3 flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
        <span>Also remove rules and restore settings that TrustifyX changed (your own Cloudflare rules are never touched)</span>
      </label>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-danger" disabled={busy} onClick={() => { setOpen(false); onConfirm(remove); }}>Disconnect</button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
    </div>
  );
}

function ZoneCard({
  zone: z,
  canManage,
  busy,
  run,
  reload,
  setNotice,
}: {
  zone: Zone;
  canManage: boolean;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  reload: () => Promise<void>;
  setNotice: (s: string | null) => void;
}) {
  const selectable = z.features.filter((f) => f.availability === "AVAILABLE" && f.state === "NOT_ENABLED");
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<"enforce" | "preview">("enforce");
  const [plan, setPlan] = useState<Planned | null>(null);
  const [results, setResults] = useState<Array<{ key: string; label: string; result: string; message: string }> | null>(null);

  return (
    <section className="card p-5" id={`zone-${z.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{z.name}</h2>
          <p className="text-sm text-ink-muted">Protects {z.website.hostname} · Cloudflare {z.plan ?? "plan unknown"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn" href={`/security-events?zone=${z.id}`}>View Security Events</Link>
          <a className="btn" href={`#rules-${z.id}`}>Review Firewall Rules</a>
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(async () => {
              const r = await api<{ eventsImported: number; eventsError: string | null }>(`/api/protection/zones/${z.id}/refresh`, { body: {} });
              await reload();
              setNotice(`Refreshed from Cloudflare. ${r.eventsError ? `Events: ${r.eventsError === "unavailable" ? "unavailable for this plan or token" : r.eventsError}` : `${r.eventsImported} new security events imported.`}`);
            })}
          >
            Refresh Data
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Pill cls={z.status === "active" ? "border-emerald-500/50 text-emerald-200" : "border-amber-400/50 text-amber-200"}>Zone {z.status}</Pill>
        {z.dns?.proxied === true && <Pill cls="border-emerald-500/50 text-emerald-200">● DNS proxied</Pill>}
        {z.dns?.proxied === false && <Pill cls="border-red-500/50 text-red-200">⨯ DNS not proxied</Pill>}
        <Pill cls={z.ddos.edgeProtected ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200" : "border-slate-500/50 text-slate-300"}>
          {z.ddos.edgeProtected ? "● Edge DDoS protection in effect" : "○ Edge protection not in effect"}
        </Pill>
        <span className="self-center text-xs text-ink-faint">Synced {when(z.lastSyncedAt)}</span>
      </div>
      {z.lastSyncError && <div className="mt-3"><Notice tone="error">{z.lastSyncError}</Notice></div>}
      {z.status === "pending" && z.nameServers?.length ? (
        <div className="mt-3">
          <Notice tone="warn">
            Finish activating this zone in Cloudflare: at your domain registrar, set the nameservers to {z.nameServers.join(" and ")}. TrustifyX does not change
            nameservers or DNS records for you.
          </Notice>
        </div>
      ) : null}

      <div className="mt-4 rounded-lg border border-navy-600 p-4 text-sm">
        <p className="font-medium">DDoS protection</p>
        <p className="mt-1 text-ink-muted">{z.ddos.summary} No service can promise to stop every attack.</p>
        {z.ddos.warnings.length > 0 && (
          <ul className="mt-2 space-y-1 text-amber-200">
            {z.ddos.warnings.map((w) => (
              <li key={w}>▲ {w}</li>
            ))}
          </ul>
        )}
      </div>

      <ul className="mt-5 divide-y divide-white/5 border-y border-white/5">
        {z.features.map((f) => (
          <li key={f.key} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3">
            {canManage && (
              <input
                type="checkbox"
                className="mt-1"
                aria-label={`Select ${f.label}`}
                disabled={!selectable.includes(f)}
                checked={selected.includes(f.key)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, f.key] : s.filter((k) => k !== f.key)))}
              />
            )}
            <div className="min-w-0 flex-1 basis-56">
              <span className="font-medium">{f.label}</span>
              <span className="block text-xs text-ink-muted">{f.description}</span>
              {f.lastError && <span className="block text-xs text-red-300">{f.lastError}</span>}
            </div>
            <div className="basis-48">
              <Pill cls={AVAIL[f.availability].cls}>{AVAIL[f.availability].text}</Pill>
              {f.reason && <span className="mt-1 block max-w-xs text-xs text-ink-faint">{f.reason}</span>}
            </div>
            <div className="basis-48">
              <Pill cls={STATE[f.state].cls}>
                <span aria-hidden>{STATE[f.state].glyph}</span> {STATE[f.state].text}
              </Pill>
              {f.verifiedAt && <span className="mt-1 block text-xs text-ink-faint">Verified {new Date(f.verifiedAt).toLocaleString()}</span>}
            </div>
            {canManage && (
              <div className="ml-auto flex gap-2 whitespace-nowrap">
                {f.state === "PREVIEW" && f.managedByTrustifyX && (
                  <button className="btn py-1" disabled={busy} onClick={() => run(async () => {
                    await api(`/api/protection/zones/${z.id}/enforce`, { body: { feature: f.key, confirm: true } });
                    await reload();
                    setNotice(`${f.label} is now enforcing (verified in Cloudflare).`);
                  })}>Enforce</button>
                )}
                {f.managedByTrustifyX && (f.state === "ENABLED" || f.state === "PREVIEW") && (
                  <button className="btn py-1" disabled={busy} onClick={() => {
                    if (!window.confirm(`Revert "${f.label}"? TrustifyX will remove its rule or restore the previous setting.`)) return;
                    void run(async () => {
                      await api(`/api/protection/zones/${z.id}/revert`, { body: { feature: f.key, confirm: true } });
                      await reload();
                      setNotice(`${f.label} reverted.`);
                    });
                  }}>Revert</button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {canManage && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-sm text-ink-muted">
            Mode{" "}
            <select className="input ml-1 inline-block w-auto max-w-full py-1.5" value={mode} onChange={(e) => setMode(e.target.value as "enforce" | "preview")}>
              <option value="enforce">Enforce</option>
              <option value="preview">Preview rules (non-blocking)</option>
            </select>
          </label>
          <button
            className="btn btn-primary"
            disabled={busy || selected.length === 0}
            onClick={() => run(async () => {
              setResults(null);
              setPlan(await api<Planned>(`/api/protection/zones/${z.id}/preview`, { body: { features: selected, mode } }));
            })}
          >
            Activate Available Protection
          </button>
          {selected.length === 0 && <span className="text-xs text-ink-faint">Select one or more available protections.</span>}
        </div>
      )}

      {plan && (
        <div className="mt-4 rounded-lg border border-sky-500/40 bg-sky-500/5 p-4">
          <p className="font-medium">Review changes for {plan.zone.name}</p>
          <p className="text-sm text-ink-muted">Read live from Cloudflare just now. Nothing has been changed yet.</p>
          <ul className="mt-3 space-y-3 text-sm">
            {plan.changes.map((c) => (
              <li key={c.key} className="rounded-md border border-navy-600 p-3">
                <span className="font-medium">{c.label}</span>{" "}
                {c.applicable ? <span className="text-sky-200">will change</span> : <span className="text-ink-faint">skipped: {c.reason}</span>}
                {c.applicable && (
                  <div className="mt-1 grid gap-1 font-mono text-xs sm:grid-cols-2">
                    <span className="break-all text-ink-muted">Before: {fmt(c.before)}</span>
                    <span className="break-all text-ink">After: {fmt(c.after)}</span>
                  </div>
                )}
                {c.applicable && c.caution && <p className="mt-1 text-xs text-amber-200">▲ {c.caution}</p>}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <button
              className="btn btn-primary"
              disabled={busy || !plan.changes.some((c) => c.applicable)}
              onClick={() => run(async () => {
                const r = await api<{ results: Array<{ key: string; label: string; result: string; message: string }> }>(`/api/protection/zones/${z.id}/apply`, {
                  body: { features: plan.changes.map((c) => c.key), mode: plan.mode, fingerprint: plan.fingerprint, confirm: true },
                });
                setResults(r.results);
                setPlan(null);
                setSelected([]);
                await reload();
              })}
            >
              Confirm and apply
            </button>
            <button className="btn" onClick={() => setPlan(null)}>Cancel</button>
          </div>
        </div>
      )}

      {results && (
        <ul className="mt-4 space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.key} className={r.result === "SUCCEEDED" ? "text-emerald-300" : r.result === "SKIPPED" ? "text-ink-muted" : "text-red-300"}>
              {r.result === "SUCCEEDED" ? "✓" : r.result === "SKIPPED" ? "–" : "⨯"} {r.label}: {r.message}
            </li>
          ))}
        </ul>
      )}

      <div id={`rules-${z.id}`} className="mt-6">
        <p className="text-sm font-medium">
          Firewall custom rules in Cloudflare{" "}
          {z.capabilities && z.capabilities.customRulesUsed !== null && (
            <span className="font-normal text-ink-muted">({z.capabilities.customRulesUsed} of {z.capabilities.customRuleLimit} on this plan)</span>
          )}
        </p>
        {z.customRules === null ? (
          <p className="mt-1 text-sm text-ink-muted">Rules could not be read with this token (Zone WAF Read permission).</p>
        ) : z.customRules.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">No custom rules.</p>
        ) : (
          <ul className="mt-2 divide-y divide-white/5 text-sm">
            {z.customRules.map((r, i) => (
              <li key={r.id ?? i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  {r.description || "(no description)"}
                  <span className="ml-2 text-xs text-ink-faint">{r.trustifyx ? "managed by TrustifyX" : "your rule, not modified by TrustifyX"}</span>
                </span>
                <span className="text-xs text-ink-muted">
                  {r.action} · {r.enabled ? "enabled" : "disabled"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManage && (
        <div className="mt-6 border-t border-white/5 pt-4 text-right">
          <button
            className="text-sm text-red-300 hover:underline"
            disabled={busy}
            onClick={() => {
              const remove = window.confirm("Remove the rules and restore the settings TrustifyX changed on this zone before unlinking? Press Cancel to unlink without changing Cloudflare.");
              if (!window.confirm(`Unlink ${z.name} from ${z.website.hostname}?`)) return;
              void run(async () => {
                await api(`/api/protection/zones/${z.id}`, { method: "DELETE", body: { removeTrustifyxChanges: remove, confirm: true } });
                await reload();
                setNotice(`${z.name} unlinked.`);
              });
            }}
          >
            Unlink zone
          </button>
        </div>
      )}
    </section>
  );
}

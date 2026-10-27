"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Empty, Notice, Section } from "@/components/ui";

interface Server {
  id: string;
  displayName: string;
  environment: string;
  os: string;
  status: "NOT_COMPATIBLE" | "PENDING_INSTALL" | "NEVER_CONNECTED" | "ACTIVE" | "DISCONNECTED" | "REMOVED";
  agentVersion: string | null;
  osName: string | null;
  lastKeepAlive: string | null;
  firstSeenAt: string | null;
  lastEventAt: string | null;
  lastSyncError: string | null;
  installAvailable: boolean;
  sendingData: boolean;
}

interface Data {
  access: { allowed: boolean; configured: boolean; eventsConfigured: boolean; reason: string | null };
  servers: Server[];
  events: Array<{ id: string; occurredAt: string; severity: string; level: number; category: string; description: string; filePath: string | null; fileEvent: string | null; ruleId: string | null; agent: { displayName: string } }>;
  last7Days: { bySeverity: Record<string, number>; byCategory: Record<string, number> };
}

interface Install {
  docs: string;
  steps: Array<{ title: string; text: string; command: string | null }>;
}

const STATUS: Record<Server["status"], { text: string; cls: string; glyph: string }> = {
  ACTIVE: { text: "Agent connected · sending data", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-200", glyph: "●" },
  PENDING_INSTALL: { text: "Setup Required · install the agent", cls: "border-amber-400/50 text-amber-200", glyph: "!" },
  NEVER_CONNECTED: { text: "Setup Required · never connected", cls: "border-amber-400/50 text-amber-200", glyph: "!" },
  DISCONNECTED: { text: "Agent disconnected", cls: "border-red-500/50 text-red-200", glyph: "▼" },
  NOT_COMPATIBLE: { text: "Not compatible (shared hosting)", cls: "border-slate-500/50 text-slate-300", glyph: "–" },
  REMOVED: { text: "Removed from manager", cls: "border-slate-500/50 text-slate-300", glyph: "–" },
};
const CATEGORY: Record<string, string> = { FILE_INTEGRITY: "File integrity", MALWARE: "Malware-related", ROOTKIT: "Rootkit check", AUTHENTICATION: "Authentication", SECURITY_LOG: "Security log" };
const SEV_CLS: Record<string, string> = { CRITICAL: "text-red-300", HIGH: "text-orange-300", MEDIUM: "text-amber-200", LOW: "text-sky-200", INFO: "text-slate-300" };

export function ServersView({ initial, canManage }: { initial: Data; canManage: boolean }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [install, setInstall] = useState<{ name: string; steps: Install } | null>(null);
  const [env, setEnv] = useState("VPS");

  const reload = async () => setData(await api<Data>("/api/servers"));
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
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
      {!data.access.configured && (
        <Notice tone="warn">Awaiting Live Configuration: the TrustifyX Wazuh manager is not configured on this installation yet, so servers cannot be connected.</Notice>
      )}
      {!data.access.allowed && <Notice tone="info">Unavailable on Current Plan. {data.access.reason}</Notice>}

      {canManage && data.access.allowed && (
        <Section title="Connect a server">
          <form
            className="grid gap-4 md:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const form = e.currentTarget;
              void run(async () => {
                const r = await api<{ compatible: boolean; install: Install | null }>("/api/servers", {
                  body: { displayName: fd.get("name"), environment: fd.get("environment"), os: fd.get("os") },
                });
                form.reset();
                setEnv("VPS");
                if (r.install) setInstall({ name: String(fd.get("name")), steps: r.install });
                await reload();
              });
            }}
          >
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Server name</span>
              <input name="name" className="input" required maxLength={80} placeholder="web-01" />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Hosting type</span>
              <select name="environment" className="input" value={env} onChange={(e) => setEnv(e.target.value)}>
                <option value="VPS">VPS</option>
                <option value="CLOUD_VM">Cloud VM (AWS, Azure, GCP…)</option>
                <option value="DEDICATED">Dedicated server</option>
                <option value="SHARED_HOSTING">Shared hosting / website builder</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Operating system</span>
              <select name="os" className="input">
                <option value="LINUX_DEB">Ubuntu / Debian</option>
                <option value="LINUX_RPM">RHEL / CentOS / Amazon Linux</option>
                <option value="WINDOWS">Windows Server</option>
                <option value="MACOS">macOS</option>
              </select>
            </label>
            <div className="flex items-end">
              <button className="btn btn-primary w-full" disabled={busy || (env !== "SHARED_HOSTING" && !data.access.configured)}>
                {busy ? "Registering…" : env === "SHARED_HOSTING" ? "Check compatibility" : "Get install steps"}
              </button>
            </div>
            {env === "SHARED_HOSTING" && (
              <p className="text-sm text-amber-200 md:col-span-4">
                Shared hosting and website builders do not allow installing a security agent, so agent-based server monitoring is not compatible. Website
                monitoring, firewall protection and scanning still work.
              </p>
            )}
            <p className="text-xs text-ink-faint md:col-span-4">
              You need administrator (root) access to the server. TrustifyX never logs in to your server, never deletes files and never changes its
              configuration; the agent only reports events.
            </p>
          </form>
        </Section>
      )}

      {install && (
        <Section title={`Install the agent on ${install.name}`} actions={<button className="btn" onClick={() => setInstall(null)}>Close</button>}>
          <ol className="space-y-4 text-sm">
            {install.steps.steps.map((s, i) => (
              <li key={i}>
                <p className="font-medium">{i + 1}. {s.title}</p>
                {s.text && <p className="text-ink-muted">{s.text}</p>}
                {s.command && <pre className="mt-1 overflow-x-auto rounded bg-navy-800 p-3 font-mono text-xs select-all">{s.command}</pre>}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-ink-faint">
            The key identifies this server to your organization only. Keep it private; it is shown until the agent first connects. Official guide:{" "}
            <a className="underline" href={install.steps.docs} target="_blank" rel="noreferrer">Wazuh agent installation</a>
          </p>
        </Section>
      )}

      <Section title="Servers">
        {data.servers.length === 0 ? (
          <Empty>Not Connected. No servers have been added.</Empty>
        ) : (
          <ul className="divide-y divide-white/5">
            {data.servers.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
                <div className="min-w-0 flex-1 basis-56">
                  <span className="font-medium">{s.displayName}</span>
                  <span className="block text-xs text-ink-faint">
                    {s.osName ?? s.os.replace("_", " ").toLowerCase()} · {s.environment.replace("_", " ").toLowerCase()}
                    {s.agentVersion ? ` · agent ${s.agentVersion}` : ""}
                  </span>
                  {s.lastSyncError && <span className="block text-xs text-red-300">{s.lastSyncError}</span>}
                </div>
                <div className="basis-64">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS[s.status].cls}`}>
                    <span aria-hidden>{STATUS[s.status].glyph}</span> {STATUS[s.status].text}
                  </span>
                  <span className="mt-1 block text-xs text-ink-faint">
                    {s.lastKeepAlive ? `Last check-in ${new Date(s.lastKeepAlive).toLocaleString()}` : "No check-in yet"}
                    {s.lastEventAt ? ` · last alert ${new Date(s.lastEventAt).toLocaleString()}` : ""}
                  </span>
                </div>
                {canManage && (
                  <div className="ml-auto flex gap-2">
                    {s.installAvailable && (
                      <button className="btn py-1" disabled={busy} onClick={() => run(async () => setInstall({ name: s.displayName, steps: await api<Install>(`/api/servers/${s.id}/install`) }))}>
                        Install steps
                      </button>
                    )}
                    <button
                      className="btn py-1"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove ${s.displayName}? It is unregistered from the Wazuh manager and its alerts are deleted from Secure360. Nothing on the server is changed.`)) return;
                        void run(async () => {
                          await api(`/api/servers/${s.id}`, { method: "DELETE" });
                          await reload();
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Server alerts (last 50)">
        {!data.access.eventsConfigured ? (
          <p className="text-sm text-ink-muted">Awaiting Live Configuration: alert import from the Wazuh indexer is not configured.</p>
        ) : data.events.length === 0 ? (
          <Empty>No server alerts have been received.</Empty>
        ) : (
          <>
            <p className="mb-3 text-xs text-ink-muted">
              Last 7 days:{" "}
              {Object.entries(data.last7Days.byCategory).map(([k, v]) => `${CATEGORY[k] ?? k} ${v}`).join(" · ") || "none"}. Malware-related alerts only appear
              where detectors (rootcheck, YARA, VirusTotal, ClamAV or Windows Defender logs) are configured.
            </p>
            <div className="overflow-x-auto">
              <table className="data min-w-[680px]">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Server</th>
                    <th>Severity</th>
                    <th>Type</th>
                    <th>Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap">{new Date(e.occurredAt).toLocaleString()}</td>
                      <td>{e.agent.displayName}</td>
                      <td className={SEV_CLS[e.severity]}>{e.severity} <span className="text-xs text-ink-faint">(level {e.level})</span></td>
                      <td>{CATEGORY[e.category] ?? e.category}</td>
                      <td>
                        {e.description}
                        {e.filePath && <span className="block font-mono text-xs break-all text-ink-faint">{e.fileEvent ? `${e.fileEvent}: ` : ""}{e.filePath}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

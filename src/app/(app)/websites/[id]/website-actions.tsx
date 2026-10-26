"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";

export function WebsiteActions({
  website,
  canScan,
  canUpdate,
  canDelete,
}: {
  website: { id: string; status: string; displayName: string; availabilityIntervalSec: number; configIntervalSec: number };
  canScan: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  async function run(label: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      if (success) setMessage(success);
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const connected = website.status === "CONNECTED";
  const paused = website.status === "MONITORING_PAUSED";

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {canScan && connected && (
          <button
            className="btn btn-primary"
            disabled={busy !== null}
            onClick={() => run("scan", () => api(`/api/websites/${website.id}/scan`, { method: "POST" }), "Rescan queued. Results appear within a minute.")}
          >
            {busy === "scan" ? "Queuing…" : "↻ Rescan now"}
          </button>
        )}
        {canUpdate && (connected || paused) && (
          <button
            className="btn btn-ghost"
            disabled={busy !== null}
            onClick={() => run("pause", () => api(`/api/websites/${website.id}`, { method: "PATCH", body: { paused: connected } }))}
          >
            {connected ? "Pause monitoring" : "Resume monitoring"}
          </button>
        )}
        {canUpdate && (
          <button className="btn btn-ghost" onClick={() => setShowSettings((s) => !s)}>
            Settings
          </button>
        )}
        {canDelete && (
          <button
            className="btn btn-danger"
            disabled={busy !== null}
            onClick={() => {
              if (!confirm(`Remove ${website.displayName}? All monitoring history and findings for it will be deleted.`)) return;
              void run("delete", async () => {
                await api(`/api/websites/${website.id}`, { method: "DELETE" });
                router.replace("/websites");
              });
            }}
          >
            Remove
          </button>
        )}
      </div>
      {message && <div className="text-xs text-ink-muted">{message}</div>}
      {showSettings && (
        <form
          className="card mt-2 w-full max-w-md space-y-3 p-4 text-left"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            void run(
              "settings",
              () =>
                api(`/api/websites/${website.id}`, {
                  method: "PATCH",
                  body: {
                    displayName: String(fd.get("displayName")),
                    availabilityIntervalSec: Number(fd.get("availability")) * 60,
                    configIntervalSec: Number(fd.get("config")) * 3600,
                  },
                }),
              "Settings saved.",
            ).then(() => setShowSettings(false));
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block text-ink-muted">Display name</span>
            <input name="displayName" className="input" defaultValue={website.displayName} maxLength={100} required />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-muted">Availability check interval</span>
            <select name="availability" className="input" defaultValue={String(Math.round(website.availabilityIntervalSec / 60))}>
              {[1, 2, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  Every {m} minute{m > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-muted">Configuration check interval (TLS, headers, DNS)</span>
            <select name="config" className="input" defaultValue={String(Math.round(website.configIntervalSec / 3600))}>
              {[1, 3, 6, 12, 24, 48, 168].map((h) => (
                <option key={h} value={h}>
                  Every {h} hour{h > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setShowSettings(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy !== null}>
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

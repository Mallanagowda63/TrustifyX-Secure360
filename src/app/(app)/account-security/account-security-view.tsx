"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Notice, Section } from "@/components/ui";

interface Status {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  requiredReasons: string[];
  pendingReset: { effectiveAt: string | null } | null;
}

type Step = { kind: "idle" } | { kind: "password" } | { kind: "scan"; qrSvg: string; secret: string } | { kind: "codes"; codes: string[] };

export function AccountSecurityView({
  initial,
  requiredNotice,
  org,
  isOwner,
}: {
  initial: Status;
  requiredNotice: "admin" | "org" | null;
  org: { name: string; requireMfaForPrivileged: boolean };
  isOwner: boolean;
}) {
  const [status, setStatus] = useState(initial);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState<"none" | "regenerate" | "disable">("none");
  const [enforce, setEnforce] = useState(org.requireMfaForPrivileged);

  const refresh = async () => setStatus(await api<Status>("/api/account/mfa"));

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

  const field = (e: React.FormEvent<HTMLFormElement>, name: string) => String(new FormData(e.currentTarget).get(name) ?? "");

  return (
    <div className="max-w-3xl space-y-6">
      {requiredNotice && !status.enabled && (
        <Notice tone="warn">
          {requiredNotice === "admin"
            ? "Platform administration requires two-factor authentication. Set it up below to continue."
            : `${org.name} requires two-factor authentication for owners and admins. Set it up below to use the portal.`}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <Section title="Two-factor authentication">
        {status.enabled ? (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm">
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">Enabled</span>
              <span className="text-ink-muted">since {new Date(status.enabledAt!).toLocaleDateString()} · authenticator app</span>
            </p>
            <p className="text-sm text-ink-muted">
              Recovery codes remaining: <strong className={status.recoveryCodesRemaining <= 2 ? "text-amber-300" : "text-ink"}>{status.recoveryCodesRemaining}</strong> of 10
              {status.recoveryCodesRemaining <= 2 && " · create new codes soon"}
            </p>
            {status.required && <p className="text-xs text-ink-faint">{status.requiredReasons.join(" ")}</p>}

            {step.kind === "codes" ? (
              <RecoveryCodes codes={step.codes} onDone={() => setStep({ kind: "idle" })} />
            ) : manage === "none" ? (
              <div className="flex flex-wrap gap-2">
                <button className="btn" onClick={() => setManage("regenerate")}>Create new recovery codes</button>
                {!status.required && <button className="btn btn-danger" onClick={() => setManage("disable")}>Turn off two-factor</button>}
              </div>
            ) : (
              <form
                className="space-y-3 rounded-lg border border-navy-600 p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const password = field(e, "password");
                  const code = field(e, "code");
                  void run(async () => {
                    if (manage === "regenerate") {
                      const r = await api<{ recoveryCodes: string[] }>("/api/account/mfa/recovery-codes", { body: { password, code } });
                      setStep({ kind: "codes", codes: r.recoveryCodes });
                    } else {
                      await api("/api/account/mfa/disable", { body: { password, code } });
                    }
                    setManage("none");
                    await refresh();
                  });
                }}
              >
                <p className="text-sm font-medium">{manage === "regenerate" ? "Create new recovery codes (old codes stop working)" : "Turn off two-factor authentication"}</p>
                <input className="input" name="password" type="password" autoComplete="current-password" placeholder="Current password" required />
                <input className="input font-mono" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code from your app" required />
                <div className="flex gap-2">
                  <button className={manage === "disable" ? "btn btn-danger" : "btn btn-primary"} disabled={busy}>
                    {busy ? "Working…" : manage === "regenerate" ? "Create codes" : "Turn off"}
                  </button>
                  <button type="button" className="btn" onClick={() => setManage("none")}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        ) : step.kind === "idle" ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Protect your account with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password or any TOTP app)
              in addition to your password.
            </p>
            <button className="btn btn-primary" onClick={() => setStep({ kind: "password" })}>Set up two-factor authentication</button>
          </div>
        ) : step.kind === "password" ? (
          <form
            className="max-w-sm space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const password = field(e, "password");
              void run(async () => {
                const r = await api<{ qrSvg: string; secret: string }>("/api/account/mfa/setup", { body: { password } });
                setStep({ kind: "scan", ...r });
              });
            }}
          >
            <p className="text-sm text-ink-muted">Step 1 of 3 · Confirm your password.</p>
            <input className="input" name="password" type="password" autoComplete="current-password" placeholder="Current password" required autoFocus />
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
              <button type="button" className="btn" onClick={() => setStep({ kind: "idle" })}>Cancel</button>
            </div>
          </form>
        ) : step.kind === "scan" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const code = field(e, "code");
              void run(async () => {
                const r = await api<{ recoveryCodes: string[] }>("/api/account/mfa/enable", { body: { code } });
                setStep({ kind: "codes", codes: r.recoveryCodes });
                await refresh();
              });
            }}
          >
            <p className="text-sm text-ink-muted">Step 2 of 3 · Scan this QR code with your authenticator app, then enter the 6-digit code it shows.</p>
            <div className="flex flex-wrap items-start gap-6">
              {/* SVG generated server-side by the qrcode library from our own otpauth URI. */}
              <div className="h-48 w-48 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: step.qrSvg }} />
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p className="text-ink-muted">Can&apos;t scan? Enter this key manually (time-based, 6 digits):</p>
                <code className="block rounded bg-navy-800 px-3 py-2 font-mono text-xs break-all select-all">{step.secret}</code>
                <p className="text-xs text-ink-faint">Keep this key private. The setup expires in 15 minutes.</p>
              </div>
            </div>
            <input className="input max-w-xs text-center font-mono text-lg tracking-[0.3em]" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required autoFocus />
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy}>{busy ? "Verifying…" : "Verify and turn on"}</button>
              <button type="button" className="btn" onClick={() => setStep({ kind: "idle" })}>Cancel</button>
            </div>
          </form>
        ) : (
          <RecoveryCodes codes={step.codes} onDone={() => setStep({ kind: "idle" })} />
        )}
      </Section>

      {status.pendingReset && (
        <Section title="Pending two-factor reset">
          <Notice tone="warn">
            A request to remove two-factor authentication is scheduled for{" "}
            {status.pendingReset.effectiveAt ? new Date(status.pendingReset.effectiveAt).toLocaleString() : "after confirmation"}. If you did not ask for this,
            cancel it and change your password.
          </Notice>
          <button
            className="btn btn-danger mt-3"
            disabled={busy}
            onClick={() => void run(async () => { await api("/api/auth/mfa/reset-cancel", { body: {} }); await refresh(); })}
          >
            Cancel reset
          </button>
        </Section>
      )}

      {isOwner && (
        <Section title="Organization policy">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={enforce}
              disabled={busy}
              onChange={(e) => {
                const value = e.target.checked;
                void run(async () => {
                  await api("/api/org", { method: "PATCH", body: { requireMfaForPrivileged: value } });
                  setEnforce(value);
                });
              }}
            />
            <span>
              <span className="font-medium">Require two-factor authentication for owners and admins of {org.name}</span>
              <span className="block text-ink-muted">
                Owners and admins without two-factor authentication can only open this page until they set it up. Members and viewers are not affected.
              </span>
            </span>
          </label>
        </Section>
      )}
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `TrustifyX Secure360 recovery codes\nEach code can be used once.\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-4">
      <Notice tone="success">Two-factor authentication is on. Save these recovery codes now. They are shown only once.</Notice>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-navy-800 p-4 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="text-xs text-ink-muted">Use a recovery code if you lose your phone. Store them in a password manager or print them and keep them safe.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(text)}>Copy</button>
        <a className="btn" download="secure360-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}>
          Download
        </a>
        <button className="btn btn-primary" onClick={onDone}>I have saved my codes</button>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/client";
import { Icon } from "@/components/marketing/Icon";
import { VerificationPanel } from "@/app/(app)/websites/[id]/verification-panel";

interface Website {
  id: string;
  hostname: string;
  url: string;
  status: string;
  state: string;
  lastAvailabilityCheckAt: string | null;
  lastConfigCheckAt: string | null;
  lastResponseTimeMs: number | null;
  lastStatusCode: number | null;
  tlsValidTo: string | null;
  lastVerificationError: string | null;
  verification: { dns: { type: string; name: string; value: string }; file: { url: string; content: string } };
}

type Step = "enter" | "verify" | "scanning" | "done";

const STEPS: Array<{ key: Step; label: string }> = [
  { key: "enter", label: "Website address" },
  { key: "verify", label: "Verify ownership" },
  { key: "scanning", label: "Initial security check" },
  { key: "done", label: "Results" },
];

/**
 * Portal onboarding: URL → server-side validation, plan & limit checks → ownership verification
 * (DNS TXT or file, plus authorization) → first scan by the existing workers → real results.
 */
export function CheckWebsiteSecurity({ plansUrl, resume, canCreate }: { plansUrl: string; resume?: Website | null; canCreate: boolean }) {
  const [step, setStep] = useState<Step>(resume ? (resume.status === "CONNECTED" ? "scanning" : "verify") : "enter");
  const [site, setSite] = useState<Website | null>(resume ?? null);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [findings, setFindings] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const started = useRef<number>(Date.now());

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { website } = await api<{ website: Website }>("/api/websites", { body: { url: fd.get("url"), displayName: fd.get("displayName") || undefined } });
      setSite(website);
      setStep("verify");
    } catch (err) {
      setError({ text: (err as Error).message, code: err instanceof ClientApiError ? err.code : undefined });
    } finally {
      setBusy(false);
    }
  }

  // Poll the real website record until both first checks have completed.
  useEffect(() => {
    if (step !== "scanning" || !site) return;
    started.current = Date.now();
    let stop = false;
    const tick = async () => {
      try {
        const { website } = await api<{ website: Website }>(`/api/websites/${site.id}`);
        if (stop) return;
        setSite(website);
        if (website.lastAvailabilityCheckAt && website.lastConfigCheckAt) {
          const r = await api<{ findings: unknown[] }>(`/api/findings?websiteId=${site.id}&status=OPEN,IN_PROGRESS`);
          setFindings(r.findings.length);
          setStep("done");
          return;
        }
        if (Date.now() - started.current > 180_000) setSlow(true);
      } catch {
        // transient; keep polling
      }
      if (!stop) setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [step, site?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <section className="relative overflow-hidden rounded-2xl border border-royal-500/30 bg-[linear-gradient(135deg,#0b1a3a,#081226_55%,#0a2027)] p-6 sm:p-8">
      <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-teal-500/10 blur-3xl" aria-hidden />
      <div className="relative">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-royal-600 to-teal-500 text-white">
            <Icon name="shieldCheck" />
          </div>
          <h2 className="font-display text-2xl font-bold text-white">Check Your Website Security</h2>
        </div>
        <p className="mt-3 max-w-3xl text-slate-300">
          Connect your website to monitor availability, SSL certificates, security configurations and potential risks with TrustifyX Secure360.
        </p>

        <ol className="mt-6 flex flex-wrap gap-2 text-xs" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li
              key={s.key}
              aria-current={i === stepIndex ? "step" : undefined}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 ${i < stepIndex ? "border-teal-400/40 text-teal-200" : i === stepIndex ? "border-royal-400/60 bg-royal-500/15 text-white" : "border-white/10 text-slate-500"}`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${i < stepIndex ? "bg-teal-400 text-[#05121f]" : "bg-white/10"}`}>
                {i < stepIndex ? "✓" : i + 1}
              </span>
              {s.label}
            </li>
          ))}
        </ol>

        {step === "enter" && (
          <form onSubmit={submit} className="mt-6 space-y-3">
            {error && (
              <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {error.code === "subscription_required" ? (
                  <>
                    <b>Subscription Required.</b> An active plan is needed to connect websites.{" "}
                    <a className="font-semibold underline" href={plansUrl}>View Pricing Plans</a>
                  </>
                ) : error.code === "plan_limit" ? (
                  <>
                    {error.text}{" "}
                    <a className="font-semibold underline" href="/sso/open?target=marketing&next=%2Faccount%2Fbilling">Upgrade plan</a>
                  </>
                ) : (
                  error.text
                )}
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-[2fr_1fr_auto]">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-300">Enter Your Website URL</span>
                <input name="url" required maxLength={2048} inputMode="url" placeholder="https://yourbusiness.com" className="portal-input" disabled={!canCreate} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-slate-300">Name (optional)</span>
                <input name="displayName" maxLength={100} placeholder="Main website" className="portal-input" disabled={!canCreate} />
              </label>
              <div className="flex items-end">
                <button className="portal-btn-primary w-full whitespace-nowrap md:w-auto" disabled={busy || !canCreate}>
                  {busy ? "Checking…" : "Check Your Website Security"}
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              HTTPS websites on public domains only. Next you prove you control the domain. We never scan websites whose ownership is not verified.
            </p>
            {!canCreate && <p className="text-sm text-amber-200">Your role cannot add websites. Ask an organization admin.</p>}
          </form>
        )}

        {step === "verify" && site && (
          <div className="mt-6">
            <VerificationPanel
              websiteId={site.id}
              hostname={site.hostname}
              instructions={site.verification}
              lastError={site.lastVerificationError}
              canVerify
              failed={site.status === "VERIFICATION_FAILED"}
              onVerified={() => setStep("scanning")}
            />
          </div>
        )}

        {step === "scanning" && site && (
          <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-6" role="status" aria-live="polite">
            <div className="flex items-center gap-3">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal-300/30 border-t-teal-300" aria-hidden />
              <h3 className="text-lg font-semibold text-white">Initial Security Check in Progress</h3>
            </div>
            <p className="mt-2 text-sm text-slate-400">Ownership of {site.hostname} is verified. Our monitoring workers are running the first checks now.</p>
            <ul className="mt-4 space-y-2 text-sm">
              <li className="flex items-center gap-2">{site.lastAvailabilityCheckAt ? <span className="text-teal-300">✓</span> : <span className="text-slate-500">○</span>} Availability &amp; response time</li>
              <li className="flex items-center gap-2">{site.lastConfigCheckAt ? <span className="text-teal-300">✓</span> : <span className="text-slate-500">○</span>} SSL/TLS certificate, security headers, HTTPS redirect and DNS</li>
            </ul>
            {slow && <p className="mt-4 text-sm text-amber-200">This is taking longer than usual. Results will appear automatically on your dashboard; you can leave this page.</p>}
          </div>
        )}

        {step === "done" && site && (
          <div className="mt-6 rounded-xl border border-teal-400/30 bg-teal-500/5 p-6">
            <h3 className="text-lg font-semibold text-white">First results for {site.hostname}</h3>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div><dt className="text-slate-400">Website status</dt><dd className={`text-lg font-semibold ${site.state === "UP" ? "text-emerald-300" : site.state === "DOWN" ? "text-red-300" : "text-white"}`}>{site.state === "UP" ? "Online" : site.state === "DOWN" ? "Offline" : "Checking"}</dd></div>
              <div><dt className="text-slate-400">Response</dt><dd className="text-lg font-semibold text-white">{site.lastResponseTimeMs !== null ? `${site.lastResponseTimeMs} ms` : "—"}</dd></div>
              <div><dt className="text-slate-400">SSL certificate</dt><dd className="text-lg font-semibold text-white">{site.tlsValidTo ? `${Math.floor((new Date(site.tlsValidTo).getTime() - Date.now()) / 86_400_000)} days left` : "—"}</dd></div>
              <div><dt className="text-slate-400">Open findings</dt><dd className="text-lg font-semibold text-white">{findings ?? "—"}</dd></div>
            </dl>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link className="portal-btn-primary" href={`/websites/${site.id}`}>View full results</Link>
              <Link className="btn btn-ghost" href="/">Go to dashboard</Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

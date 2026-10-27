"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Notice } from "@/components/ui";

interface Instructions {
  dns: { type: string; name: string; value: string };
  file: { url: string; content: string };
}

function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-xs text-ink-muted">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-x-auto rounded-md border border-navy-600 bg-navy-950 px-3 py-2 text-xs whitespace-nowrap">{value}</code>
        <button
          type="button"
          className="btn btn-ghost py-1 text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function VerificationPanel({
  websiteId,
  hostname,
  instructions,
  lastError,
  canVerify,
  failed,
  onVerified,
}: {
  websiteId: string;
  hostname: string;
  instructions: Instructions;
  lastError: string | null;
  canVerify: boolean;
  failed: boolean;
  /** Called after successful verification (onboarding flow continues to the first scan). */
  onVerified?: () => void;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<"DNS_TXT" | "HTTP_FILE">("DNS_TXT");
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function verify() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ verified: boolean; detail: string }>(`/api/websites/${websiteId}/verify`, {
        body: { method, authorizationConfirmed: authorized },
      });
      setResult({ ok: r.verified, message: r.verified ? "Ownership verified. Monitoring has started." : r.detail });
      if (r.verified && onVerified) onVerified();
      else router.refresh();
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card space-y-5 p-5">
      <div>
        <h2 className="text-base font-semibold">Verify ownership of {hostname}</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Monitoring starts only after you prove you control this domain. Choose one method, publish the value, then click Verify.
          Keep the record or file in place: ownership is re-checked daily.
        </p>
      </div>
      {failed && lastError && <Notice tone="error">Last attempt failed: {lastError}</Notice>}

      <div className="flex gap-2" role="tablist">
        {(["DNS_TXT", "HTTP_FILE"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={method === m}
            className={`btn ${method === m ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMethod(m)}
          >
            {m === "DNS_TXT" ? "DNS TXT record" : "Verification file"}
          </button>
        ))}
      </div>

      {method === "DNS_TXT" ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">Add this TXT record at your DNS provider (Cloudflare, GoDaddy, Route 53, …):</p>
          <div className="grid gap-3 md:grid-cols-[6rem_1fr]">
            <Copyable label="Type" value={instructions.dns.type} />
            <Copyable label="Name / Host" value={instructions.dns.name} />
          </div>
          <Copyable label="Value" value={instructions.dns.value} />
          <p className="text-xs text-ink-faint">
            Many DNS providers append your root domain automatically. If so, enter the name without the root domain at the end
            (for <code>www.example.com</code> that is <code>_trustifyx-verify.www</code>). DNS changes can take a few minutes to
            propagate.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">Create a plain-text file on your web server so that it is served at this exact URL over HTTPS:</p>
          <Copyable label="File URL" value={instructions.file.url} />
          <Copyable label="File content" value={instructions.file.content} />
          <p className="text-xs text-ink-faint">The file must return HTTP 200. Redirects to a different hostname are not accepted.</p>
        </div>
      )}

      {canVerify ? (
        <div className="space-y-3 border-t border-navy-700 pt-4">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
            <span>
              I confirm that I own this website or am authorized by its owner to run non-intrusive security monitoring against it
              (availability, TLS, HTTP header and DNS checks).
            </span>
          </label>
          <button className="btn btn-primary" disabled={!authorized || busy} onClick={verify}>
            {busy ? "Checking…" : "Verify ownership"}
          </button>
          {result && <Notice tone={result.ok ? "success" : "error"}>{result.message}</Notice>}
        </div>
      ) : (
        <Notice>Your role cannot verify websites. Ask an organization member or admin.</Notice>
      )}
    </section>
  );
}

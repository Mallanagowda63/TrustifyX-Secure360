"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { AiText } from "./AiText";
import { Notice } from "./ui";

interface AiAnswer {
  answer: string;
  provider: string;
  model: string;
  generatedAt: string;
}

/** Button that calls one AI endpoint and renders the grounded answer. */
export function AiPanel({
  endpoint,
  body,
  label,
  enabled,
  compact,
}: {
  endpoint: string;
  body?: Record<string, unknown>;
  label: string;
  enabled: boolean;
  compact?: boolean;
}) {
  const [result, setResult] = useState<AiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!enabled) {
    return compact ? null : (
      <Notice>The AI assistant is not configured on this server. Set AI_PROVIDER and AI_API_KEY to enable explanations and recommendations.</Notice>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<AiAnswer>(endpoint, { method: "POST", body: body ?? {} }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button className={`btn ${compact ? "btn-ghost w-full" : "btn-primary"}`} onClick={run} disabled={busy}>
        {busy ? "✦ Analysing monitoring data…" : `✦ ${label}`}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <div className="rounded-lg border border-brand/40 bg-brand/5 p-4">
          <AiText text={result.answer} />
          <p className="mt-3 text-[11px] text-ink-faint">
            AI-generated from your verified monitoring data ({result.model}). It cannot make changes for you. Review before acting.
          </p>
        </div>
      )}
    </div>
  );
}

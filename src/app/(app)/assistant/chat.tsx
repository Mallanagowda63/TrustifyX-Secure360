"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { AiText } from "@/components/AiText";
import { Notice } from "@/components/ui";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "Which issue should I fix first, and why?",
  "Is my TLS certificate configuration healthy?",
  "Explain the configuration changes detected this month.",
  "How do I add HSTS on nginx safely?",
];

export function Chat({ sites }: { sites: Array<{ id: string; hostname: string }> }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [websiteId, setWebsiteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(q: string) {
    const text = q.trim();
    if (text.length < 3) return;
    setBusy(true);
    setError(null);
    setQuestion("");
    const history = turns.slice(-6);
    setTurns((t) => [...t, { role: "user", content: text }]);
    try {
      const r = await api<{ answer: string }>("/api/ai/ask", { body: { question: text, websiteId: websiteId || undefined, history } });
      setTurns((t) => [...t, { role: "assistant", content: r.answer }]);
    } catch (err) {
      setError((err as Error).message);
      setTurns((t) => t.slice(0, -1));
      setQuestion(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="max-h-[32rem] space-y-3 overflow-y-auto">
        {turns.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn btn-ghost py-1 text-xs font-normal" onClick={() => send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="ml-auto max-w-[85%] rounded-lg bg-brand-strong/25 px-4 py-2 text-sm">
              {t.content}
            </div>
          ) : (
            <div key={i} className="max-w-[95%] rounded-lg border border-navy-700 bg-navy-900 px-4 py-3">
              <AiText text={t.content} />
            </div>
          ),
        )}
        {busy && <div className="text-sm text-ink-muted">✦ Thinking…</div>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        className="flex flex-col gap-2 md:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(question);
        }}
      >
        <select className="input md:w-56" value={websiteId} onChange={(e) => setWebsiteId(e.target.value)} aria-label="Website scope">
          <option value="">All websites</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.hostname}
            </option>
          ))}
        </select>
        <input
          className="input flex-1"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about your monitored websites…"
          maxLength={2000}
          aria-label="Question"
        />
        <button className="btn btn-primary" disabled={busy || question.trim().length < 3}>
          Ask
        </button>
      </form>
      <p className="text-[11px] text-ink-faint">AI answers can be wrong. They only reflect data Secure360 has observed and never include actions taken on your behalf.</p>
    </div>
  );
}

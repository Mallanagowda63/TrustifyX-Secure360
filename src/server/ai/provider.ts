import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

export class AiUnavailableError extends Error {}
export class AiRefusalError extends Error {}

export interface AiRequest {
  system: string;
  user: string;
  /** Prior turns for follow-up questions (already sanitised). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  effort?: "low" | "medium" | "high";
}

export interface AiProvider {
  name: string;
  model: string;
  complete(req: AiRequest): Promise<string>;
}

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
// Models that accept the server-side refusal fallback in its "default" routing form.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function anthropicProvider(apiKey: string, model: string, baseURL?: string): AiProvider {
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, timeout: 120_000, maxRetries: 2 });
  // Server-side fallbacks are a Claude API feature; skip them when routed through a custom gateway.
  const useFallbacks = FALLBACK_MODELS.has(model) && !baseURL;
  return {
    name: "anthropic",
    model,
    async complete(req) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system: req.system,
        messages: [...(req.history ?? []), { role: "user", content: req.user }],
        output_config: { effort: req.effort ?? "medium" },
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      if (response.stop_reason === "refusal") {
        throw new AiRefusalError("The AI provider declined to answer this request.");
      }
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) throw new AiUnavailableError("The AI provider returned an empty response.");
      return text;
    },
  };
}

/** Any OpenAI-compatible chat-completions endpoint (OpenAI, Azure gateway, self-hosted). */
function openAiCompatibleProvider(apiKey: string, model: string, baseURL?: string): AiProvider {
  const base = (baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    name: "openai",
    model,
    async complete(req) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: req.system }, ...(req.history ?? []), { role: "user", content: req.user }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new AiUnavailableError(`AI provider returned HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "content_filter") throw new AiRefusalError("The AI provider declined to answer this request.");
      const text = choice?.message?.content?.trim();
      if (!text) throw new AiUnavailableError("The AI provider returned an empty response.");
      return text;
    },
  };
}

let override: AiProvider | null | undefined;

/** Tests inject a fake provider here. */
export function setAiProvider(p: AiProvider | null | undefined) {
  override = p;
}

/** Configured provider, or null when AI is disabled (AI_PROVIDER=none or no key). */
export function aiProvider(): AiProvider | null {
  if (override !== undefined) return override;
  const e = env();
  if (e.AI_PROVIDER === "none" || !e.AI_API_KEY) return null;
  if (e.AI_PROVIDER === "anthropic") return anthropicProvider(e.AI_API_KEY, e.AI_MODEL || DEFAULT_ANTHROPIC_MODEL, e.AI_BASE_URL);
  if (!e.AI_MODEL) return null;
  return openAiCompatibleProvider(e.AI_API_KEY, e.AI_MODEL, e.AI_BASE_URL);
}

export function aiEnabled(): boolean {
  return aiProvider() !== null;
}

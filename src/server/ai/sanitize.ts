/**
 * Data minimisation for AI requests. Only monitoring observations needed for the question
 * are sent; account data (users, emails, tokens, IPs of visitors) is never included, and
 * anything that looks like a secret is redacted before it leaves the platform.
 */

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b/g, "[REDACTED_SECRET]"],
  [/\btrustifyx-site-verification=[A-Za-z0-9_-]+/g, "trustifyx-site-verification=[REDACTED]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[REDACTED_EMAIL]"],
  [/([?&](?:token|key|secret|password|pass|auth|sig|signature|session|code)=)[^&\s"]+/gi, "$1[REDACTED]"],
  [/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*(?!\[REDACTED)[^\s&"',;]+/gi, "[REDACTED_CREDENTIAL]"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED_HEX]"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, "[REDACTED_TOKEN]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

const DROP_KEYS = new Set([
  "verificationToken",
  "passwordHash",
  "tokenHash",
  "csrfToken",
  "encryptedCredentials",
  "email",
  "recipient",
  "userId",
  "statusChangedById",
  "authorizedById",
  "ip",
  "remoteAddress",
  "fingerprint256",
  "serialNumber",
]);

/** Deep-copies a value, dropping sensitive keys, redacting strings and bounding size. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return redact(value).slice(0, 1500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** Serialises sanitised context for the prompt, with a hard size cap. */
export function toPromptData(value: unknown, maxChars = 60_000): string {
  const json = JSON.stringify(sanitize(value), null, 1);
  return json.length > maxChars ? `${json.slice(0, maxChars)}\n... [data truncated]` : json;
}

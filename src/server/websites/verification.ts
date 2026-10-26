import { dnsResolver } from "../security/dns-resolver";
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "../security/safe-fetch";

export const TXT_PREFIX = "trustifyx-site-verification=";
export const VERIFICATION_FILE_PATH = "/.well-known/trustifyx-verification.txt";

export function txtRecordName(hostname: string): string {
  return `_trustifyx-verify.${hostname}`;
}

export function expectedTxtValue(token: string): string {
  return `${TXT_PREFIX}${token}`;
}

export function verificationFileUrl(hostname: string): string {
  return `https://${hostname}${VERIFICATION_FILE_PATH}`;
}

export function verificationInstructions(hostname: string, token: string) {
  return {
    dns: {
      type: "TXT",
      name: txtRecordName(hostname),
      value: expectedTxtValue(token),
    },
    file: {
      url: verificationFileUrl(hostname),
      content: expectedTxtValue(token),
    },
  };
}

export interface VerificationResult {
  ok: boolean;
  detail: string;
}

export type TxtResolver = (name: string) => Promise<string[][]>;

export const systemTxtResolver: TxtResolver = (name) => dnsResolver().resolveTxt(name);

export async function verifyDnsTxt(
  hostname: string,
  token: string,
  resolveTxt: TxtResolver = systemTxtResolver,
): Promise<VerificationResult> {
  const name = txtRecordName(hostname);
  let records: string[][];
  try {
    records = await resolveTxt(name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { ok: false, detail: `No TXT record found at ${name}. DNS changes can take a few minutes to propagate.` };
    }
    return { ok: false, detail: `DNS lookup for ${name} failed (${code ?? "error"}).` };
  }
  // Long TXT values may be split into multiple strings; they are concatenated per RFC 7208 §3.3.
  const values = records.map((chunks) => chunks.join("").trim());
  if (values.includes(expectedTxtValue(token))) {
    return { ok: true, detail: `TXT record ${name} matched.` };
  }
  return {
    ok: false,
    detail: `Found ${values.length} TXT record(s) at ${name}, but none matched the expected verification value.`,
  };
}

export async function verifyHttpFile(
  hostname: string,
  token: string,
  opts: Partial<SafeFetchOptions> & { /** Test hook replacing https://<hostname> */ baseUrl?: string } = {},
): Promise<VerificationResult> {
  const { baseUrl, ...fetchOpts } = opts;
  const url = baseUrl ? `${baseUrl}${VERIFICATION_FILE_PATH}` : verificationFileUrl(hostname);
  try {
    // Redirects may only stay on the same hostname, so a file on another site cannot prove ownership.
    const res = await safeFetch(url, { maxBodyBytes: 4096, sameHostOnly: true, timeoutMs: 10000, ...fetchOpts });
    if (res.status !== 200) {
      return { ok: false, detail: `${url} returned HTTP ${res.status}; expected 200.` };
    }
    const lines = res.body.toString("utf8").split(/\r?\n/).map((l) => l.trim());
    if (lines.includes(expectedTxtValue(token))) {
      return { ok: true, detail: `Verification file at ${url} matched.` };
    }
    return { ok: false, detail: `${url} was reachable but did not contain the expected verification value.` };
  } catch (err) {
    if (err instanceof SafeFetchError) return { ok: false, detail: `Could not fetch ${url}: ${err.message}` };
    return { ok: false, detail: `Could not fetch ${url}.` };
  }
}

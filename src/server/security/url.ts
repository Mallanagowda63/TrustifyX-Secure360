import { parse as parseDomain } from "tldts";
import { isIpLiteral } from "./ip";

export class UrlValidationError extends Error {}

const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "private",
  "test",
  "example",
  "invalid",
  "onion",
  "home.arpa",
  "arpa",
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export interface NormalizedWebsite {
  /** https://hostname/path (no query, fragment, credentials or explicit port) */
  url: string;
  hostname: string;
  /** Registrable domain, e.g. example.co.uk */
  registrableDomain: string;
}

/**
 * Validates a customer-supplied website URL and normalizes it.
 * Only public HTTPS hostnames on the default port are accepted.
 */
export function normalizeWebsiteUrl(input: string): NormalizedWebsite {
  const raw = input.trim();
  if (!raw) throw new UrlValidationError("Website URL is required");
  if (raw.length > 2048) throw new UrlValidationError("URL is too long");

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new UrlValidationError("That does not look like a valid URL");
  }

  if (u.protocol !== "https:") throw new UrlValidationError("Only https:// websites can be connected");
  if (u.username || u.password) throw new UrlValidationError("URLs containing credentials are not allowed");
  if (u.port && u.port !== "443") throw new UrlValidationError("Only the default HTTPS port (443) is supported");

  // WHATWG URL already lowercases and converts IDNs to punycode.
  let hostname = u.hostname.replace(/\.$/, "");
  if (isIpLiteral(hostname)) throw new UrlValidationError("IP addresses are not allowed; use a domain name");
  if (hostname.length > 253) throw new UrlValidationError("Hostname is too long");

  const labels = hostname.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw new UrlValidationError("Hostname is not a valid public domain name");
  }
  const lower = hostname.toLowerCase();
  if (RESERVED_SUFFIXES.some((s) => lower === s || lower.endsWith(`.${s}`))) {
    throw new UrlValidationError("Internal or reserved domain names cannot be monitored");
  }

  const info = parseDomain(lower, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || !info.publicSuffix || !(info.isIcann || info.isPrivate)) {
    throw new UrlValidationError("Hostname must be under a recognised public domain suffix");
  }
  hostname = lower;

  const path = u.pathname && u.pathname !== "" ? u.pathname : "/";
  return { url: `https://${hostname}${path}`, hostname, registrableDomain: info.domain };
}

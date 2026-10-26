import type { IncomingHttpHeaders } from "node:http";

export interface CookieFlags {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

export interface HeaderInfo {
  url: string;
  statusCode: number;
  hsts: { present: boolean; raw: string | null; maxAge: number | null; includeSubDomains: boolean; preload: boolean };
  csp: {
    present: boolean;
    reportOnly: boolean;
    raw: string | null;
    hasFrameAncestors: boolean;
    scriptUnsafeInline: boolean;
    scriptUnsafeEval: boolean;
  };
  xContentTypeOptions: string | null;
  referrerPolicy: string | null;
  xFrameOptions: string | null;
  permissionsPolicy: string | null;
  server: string | null;
  xPoweredBy: string | null;
  /** Cookie names and flags only; cookie values are never stored. */
  cookies: CookieFlags[];
}

function one(h: IncomingHttpHeaders, name: string): string | null {
  const v = h[name];
  if (v === undefined) return null;
  return (Array.isArray(v) ? v.join(", ") : v).slice(0, 2000);
}

export function parseHsts(raw: string | null): HeaderInfo["hsts"] {
  if (!raw) return { present: false, raw: null, maxAge: null, includeSubDomains: false, preload: false };
  const parts = raw.split(";").map((p) => p.trim().toLowerCase());
  const ma = parts.find((p) => p.startsWith("max-age="));
  const maxAge = ma ? Number.parseInt(ma.slice(8).replace(/"/g, ""), 10) : null;
  return {
    present: true,
    raw,
    maxAge: maxAge !== null && Number.isFinite(maxAge) ? maxAge : null,
    includeSubDomains: parts.includes("includesubdomains"),
    preload: parts.includes("preload"),
  };
}

export function parseCsp(raw: string | null, reportOnly: boolean): HeaderInfo["csp"] {
  if (!raw) {
    return { present: false, reportOnly, raw: null, hasFrameAncestors: false, scriptUnsafeInline: false, scriptUnsafeEval: false };
  }
  const directives = new Map<string, string[]>();
  for (const part of raw.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values.map((v) => v.toLowerCase()));
  }
  const script = directives.get("script-src") ?? directives.get("default-src") ?? [];
  // 'unsafe-inline' is ignored by browsers when a nonce/hash or 'strict-dynamic' is present.
  const neutralised = script.some((v) => v.startsWith("'nonce-") || v.startsWith("'sha") || v === "'strict-dynamic'");
  return {
    present: true,
    reportOnly,
    raw,
    hasFrameAncestors: directives.has("frame-ancestors"),
    scriptUnsafeInline: script.includes("'unsafe-inline'") && !neutralised,
    scriptUnsafeEval: script.includes("'unsafe-eval'"),
  };
}

export function parseSetCookie(values: string[] | undefined): CookieFlags[] {
  if (!values) return [];
  return values.slice(0, 50).map((c) => {
    const [pair, ...attrs] = c.split(";");
    const name = pair.split("=")[0].trim().slice(0, 100);
    const lower = attrs.map((a) => a.trim().toLowerCase());
    const ss = lower.find((a) => a.startsWith("samesite="));
    return {
      name,
      secure: lower.includes("secure"),
      httpOnly: lower.includes("httponly"),
      sameSite: ss ? ss.slice(9) : null,
    };
  });
}

export function analyzeHeaders(url: string, statusCode: number, h: IncomingHttpHeaders): HeaderInfo {
  const cspRaw = one(h, "content-security-policy");
  const cspRo = one(h, "content-security-policy-report-only");
  return {
    url,
    statusCode,
    hsts: parseHsts(one(h, "strict-transport-security")),
    csp: cspRaw ? parseCsp(cspRaw, false) : parseCsp(cspRo, Boolean(cspRo)),
    xContentTypeOptions: one(h, "x-content-type-options"),
    referrerPolicy: one(h, "referrer-policy"),
    xFrameOptions: one(h, "x-frame-options"),
    permissionsPolicy: one(h, "permissions-policy"),
    server: one(h, "server")?.slice(0, 200) ?? null,
    xPoweredBy: one(h, "x-powered-by")?.slice(0, 200) ?? null,
    cookies: parseSetCookie(h["set-cookie"]),
  };
}

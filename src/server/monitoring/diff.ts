import type { ConfigCategory, ConfigObservation } from "./types";

export interface FieldChange {
  category: ConfigCategory;
  field: string;
  previousValue: string | null;
  newValue: string | null;
}

/** Flattens the externally observable configuration into comparable fields. */
export function trackedFields(o: ConfigObservation): Map<string, { category: ConfigCategory; value: string | null }> {
  const m = new Map<string, { category: ConfigCategory; value: string | null }>();
  const set = (category: ConfigCategory, field: string, value: unknown) =>
    m.set(`${category}.${field}`, {
      category,
      value: value === null || value === undefined ? null : Array.isArray(value) ? value.join(", ") || null : String(value),
    });

  if (o.tls) {
    set("tls", "issuer", o.tls.issuer);
    set("tls", "validTo", o.tls.validTo);
    set("tls", "fingerprint256", o.tls.fingerprint256);
    set("tls", "protocol", o.tls.protocol);
    set("tls", "trusted", o.tls.authorized && o.tls.hostnameMatches);
  }
  if (o.headers) {
    set("headers", "strict-transport-security", o.headers.hsts.raw);
    set("headers", "content-security-policy", o.headers.csp.raw);
    set("headers", "x-content-type-options", o.headers.xContentTypeOptions);
    set("headers", "referrer-policy", o.headers.referrerPolicy);
    set("headers", "x-frame-options", o.headers.xFrameOptions);
    set("headers", "permissions-policy", o.headers.permissionsPolicy);
    set("headers", "server", o.headers.server);
  }
  if (o.https) {
    set("https", "httpReachable", o.https.httpReachable);
    set("https", "redirectsToHttps", o.https.redirectsToHttps);
  }
  if (o.dns) {
    set("dns", "A", o.dns.A);
    set("dns", "AAAA", o.dns.AAAA);
    set("dns", "CNAME", o.dns.CNAME);
    set("dns", "NS", o.dns.NS);
    set("dns", "MX", o.dns.MX);
    set("dns", "CAA", o.dns.CAA);
    set("dns", "SPF", o.dns.spf);
    set("dns", "DMARC", o.dns.dmarc);
  }
  return m;
}

/**
 * Compares two observations. Only categories observed successfully in BOTH runs are
 * compared, so a failed lookup is never reported as "record removed".
 */
export function diffObservations(prev: ConfigObservation | null, next: ConfigObservation): FieldChange[] {
  if (!prev) return [];
  const a = trackedFields(prev);
  const b = trackedFields(next);
  const changes: FieldChange[] = [];
  for (const [key, nv] of b) {
    const pv = a.get(key);
    if (!pv) continue;
    if ((pv.value ?? null) !== (nv.value ?? null)) {
      changes.push({
        category: nv.category,
        field: key.slice(nv.category.length + 1),
        previousValue: pv.value?.slice(0, 2000) ?? null,
        newValue: nv.value?.slice(0, 2000) ?? null,
      });
    }
  }
  return changes;
}

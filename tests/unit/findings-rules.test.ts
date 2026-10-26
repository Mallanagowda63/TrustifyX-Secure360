import { describe, expect, it } from "vitest";
import { evaluateRules, evaluatedCategories } from "@/server/findings/rules";
import { analyzeHeaders } from "@/server/monitoring/headers";
import { diffObservations } from "@/server/monitoring/diff";
import { tlsThreshold } from "@/server/alerts/events";
import { hardenedObservation, tls } from "../helpers/fixtures";

const ids = (o: ReturnType<typeof evaluateRules>) => o.map((x) => x.ruleId).sort();

describe("findings rules", () => {
  it("produces no findings for a hardened website", () => {
    expect(evaluateRules(hardenedObservation(), "example.com")).toEqual([]);
  });

  it("reports missing headers as low/medium hardening observations, never as an attack", () => {
    const obs = hardenedObservation({ headers: analyzeHeaders("https://example.com/", 200, {}) });
    const findings = evaluateRules(obs, "example.com");
    expect(ids(findings)).toEqual([
      "headers.csp_missing",
      "headers.framing_unrestricted",
      "headers.hsts_missing",
      "headers.referrer_policy_missing",
      "headers.xcto_missing",
    ]);
    for (const f of findings) {
      expect(["INFO", "LOW", "MEDIUM"]).toContain(f.severity);
      expect(f.description).toMatch(/not evidence that the website has been attacked or compromised/);
      expect(`${f.title} ${f.description}`).not.toMatch(/\b(attack(ed)? detected|breach|compromised by|exploit(ed)?|CVE-\d)/i);
      expect(f.evidence).toHaveProperty("observedAt");
      expect(f.remediation.length).toBeGreaterThan(20);
    }
  });

  it("classifies an expired certificate as critical with certificate evidence", () => {
    const obs = hardenedObservation({ tls: tls({ expired: true, daysRemaining: -2 }) });
    const [f] = evaluateRules(obs, "example.com");
    expect(f.ruleId).toBe("tls.expired");
    expect(f.severity).toBe("CRITICAL");
    expect(f.evidence).toMatchObject({ fingerprint256: "AA:BB:CC", daysRemaining: -2 });
  });

  it("grades expiring certificates by time remaining", () => {
    expect(evaluateRules(hardenedObservation({ tls: tls({ daysRemaining: 25 }) }), "example.com")[0]).toMatchObject({
      ruleId: "tls.expiring",
      severity: "MEDIUM",
    });
    expect(evaluateRules(hardenedObservation({ tls: tls({ daysRemaining: 5 }) }), "example.com")[0]).toMatchObject({
      ruleId: "tls.expiring",
      severity: "HIGH",
    });
    expect(evaluateRules(hardenedObservation({ tls: tls({ daysRemaining: 31 }) }), "example.com")).toEqual([]);
  });

  it("flags untrusted or mismatched certificates", () => {
    expect(ids(evaluateRules(hardenedObservation({ tls: tls({ authorized: false, authorizationError: "SELF_SIGNED_CERT_IN_CHAIN" }) }), "example.com"))).toEqual([
      "tls.untrusted",
    ]);
    const mismatch = evaluateRules(hardenedObservation({ tls: tls({ hostnameMatches: false }) }), "example.com");
    expect(mismatch[0].title).toMatch(/does not match/);
  });

  it("flags plain HTTP served without redirect, but not a closed port 80", () => {
    const served = hardenedObservation({
      https: { httpReachable: true, redirectsToHttps: false, finalIsHttps: false, firstStatus: 200, firstLocation: null, finalUrl: "http://example.com/", error: null },
    });
    expect(ids(evaluateRules(served, "example.com"))).toEqual(["https.not_enforced"]);
    const closed = hardenedObservation({
      https: { httpReachable: false, redirectsToHttps: false, finalIsHttps: false, firstStatus: null, firstLocation: null, finalUrl: null, error: "ECONNREFUSED" },
    });
    expect(evaluateRules(closed, "example.com")).toEqual([]);
  });

  it("does not run rules for categories whose check failed", () => {
    const obs = hardenedObservation({ tls: null, headers: null, errors: { tls: "timeout", headers: "timeout" } });
    expect(evaluateRules(obs, "example.com")).toEqual([]);
    expect(evaluatedCategories(obs)).toEqual(["https", "dns"]);
  });

  it("treats nonce-based CSP as not unsafe-inline", () => {
    const h = analyzeHeaders("https://example.com/", 200, {
      "content-security-policy": "script-src 'self' 'unsafe-inline' 'nonce-abc123'; frame-ancestors 'self'",
    });
    expect(h.csp.scriptUnsafeInline).toBe(false);
  });

  it("never stores cookie values, only names and flags", () => {
    const h = analyzeHeaders("https://example.com/", 200, { "set-cookie": ["session=SECRETVALUE; Path=/; HttpOnly"] });
    expect(JSON.stringify(h)).not.toContain("SECRETVALUE");
    const f = evaluateRules(hardenedObservation({ headers: { ...h, ...analyzeHeaders("https://example.com/", 200, {}), cookies: h.cookies } }), "example.com");
    expect(f.find((x) => x.ruleId === "headers.cookie_not_secure")?.evidence).toMatchObject({ cookieNames: ["session"] });
  });

  it("only flags missing DMARC/SPF when the domain receives mail", () => {
    const base = hardenedObservation();
    const noMail = hardenedObservation({ dns: { ...base.dns!, MX: [], spf: null, dmarc: null } });
    expect(evaluateRules(noMail, "example.com")).toEqual([]);
    const nullMx = hardenedObservation({ dns: { ...base.dns!, MX: ["0 ."], spf: null, dmarc: null } });
    expect(evaluateRules(nullMx, "example.com")).toEqual([]);
    const mail = hardenedObservation({ dns: { ...base.dns!, spf: null, dmarc: null } });
    expect(ids(evaluateRules(mail, "example.com"))).toEqual(["dns.dmarc_missing", "dns.spf_missing"]);
  });
});

describe("configuration diff", () => {
  it("reports changed fields", () => {
    const a = hardenedObservation();
    const b = hardenedObservation({ dns: { ...a.dns!, A: ["203.0.113.9"] }, tls: tls({ issuer: "DigiCert", fingerprint256: "DD:EE" }) });
    const changes = diffObservations(a, b);
    expect(changes.map((c) => `${c.category}.${c.field}`).sort()).toEqual(["dns.A", "tls.fingerprint256", "tls.issuer"]);
    expect(changes.find((c) => c.field === "A")).toMatchObject({ previousValue: "93.184.216.34", newValue: "203.0.113.9" });
  });

  it("does not report a failed check as a removed record", () => {
    const a = hardenedObservation();
    expect(diffObservations(a, hardenedObservation({ dns: null, errors: { dns: "SERVFAIL" } }))).toEqual([]);
  });

  it("returns nothing on the first observation", () => {
    expect(diffObservations(null, hardenedObservation())).toEqual([]);
  });
});

describe("TLS expiry notification thresholds", () => {
  it.each([
    [45, null],
    [30, 30],
    [20, 30],
    [14, 14],
    [8, 14],
    [7, 7],
    [2, 3],
    [1, 1],
    [0, 0],
    [-5, 0],
  ])("%i days remaining → threshold %s", (days, expected) => {
    expect(tlsThreshold(days)).toBe(expected);
  });
});

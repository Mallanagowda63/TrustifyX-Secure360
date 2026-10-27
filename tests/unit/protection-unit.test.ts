import { describe, expect, it } from "vitest";
import { FEATURES, featureByKey, normalizePlan, planAvailability } from "@/server/protection/features";
import { analyzeDns, ddosStatus, zoneMatchesHost } from "@/server/protection/service";
import { actionGroup, eventKey, eventsQuery, toRow } from "@/server/protection/events";
import { CloudflareClient } from "@/server/integrations/cloudflare/client";

describe("Cloudflare plan rules", () => {
  it("normalises plan identifiers", () => {
    expect(normalizePlan("free")).toBe("free");
    expect(normalizePlan(undefined, "Pro Website")).toBe("pro");
    expect(normalizePlan("business")).toBe("business");
    expect(normalizePlan("enterprise")).toBe("enterprise");
    expect(normalizePlan(null, null)).toBe("unknown");
  });

  it("matches Cloudflare's documented availability", () => {
    const managed = featureByKey("managed_waf")!;
    expect(planAvailability(managed, "free").available).toBe(false);
    expect(planAvailability(managed, "pro").available).toBe(true);
    const bfm = featureByKey("bot_fight_mode")!;
    expect(planAvailability(bfm, "free").available).toBe(true);
    expect(planAvailability(bfm, "business").available).toBe(false);
    for (const f of FEATURES) expect(planAvailability(f, "unknown").available).toBe(false);
  });

  it("only offers custom-rule actions available on every plan (no Enterprise-only log)", () => {
    for (const f of FEATURES) if (f.kind === "custom_rule") expect(["block", "managed_challenge"]).toContain(f.action);
  });
});

describe("zone ↔ website matching", () => {
  it.each([
    ["shop.example", "shop.example", true],
    ["shop.example", "www.shop.example", true],
    ["shop.example", "a.b.shop.example", true],
    ["shop.example", "evilshop.example", false],
    ["shop.example", "shop.example.attacker.net", false],
    ["sub.shop.example", "shop.example", false],
  ])("%s covers %s → %s", (zone, host, expected) => {
    expect(zoneMatchesHost(zone, host)).toBe(expected);
  });
});

describe("DNS proxy and origin exposure", () => {
  it("flags unproxied names that point to the website's origin address", () => {
    const r = analyzeDns(
      [
        { id: "1", type: "A", name: "www.shop.example", content: "203.0.113.10", proxied: true },
        { id: "2", type: "A", name: "ftp.shop.example", content: "203.0.113.10", proxied: false },
        { id: "3", type: "A", name: "vpn.shop.example", content: "192.0.2.1", proxied: false },
      ],
      "www.shop.example",
    );
    expect(r).toEqual({ hostRecords: [{ type: "A", name: "www.shop.example", proxied: true }], proxied: true, exposedRecords: ["ftp.shop.example"] });
  });

  it("does not claim edge protection without facts", () => {
    expect(ddosStatus({ status: "pending", paused: false }, null).edgeProtected).toBe(false);
    expect(ddosStatus({ status: "active", paused: true }, null).warnings.join(" ")).toContain("paused");
  });
});

describe("security event import helpers", () => {
  it("builds queries only from whitelisted field names", () => {
    const q = eventsQuery(["datetime", "action", "}} evil { x", "clientIP"]);
    expect(q).toContain("{ datetime action clientIP }");
    expect(q).not.toContain("evil");
  });

  it("keys events by Ray ID + rule when available, else by content hash", () => {
    expect(eventKey({ rayName: "abc", ruleId: "r", action: "block", source: "waf" })).toBe("ray:abc:r:block:waf");
    const a = eventKey({ datetime: "2026-10-27T00:00:00Z", action: "block", clientRequestPath: "/a" });
    expect(a).toMatch(/^h:[a-f0-9]{64}$/);
    expect(eventKey({ datetime: "2026-10-27T00:00:00Z", action: "block", clientRequestPath: "/a" })).toBe(a);
    expect(eventKey({ datetime: "2026-10-27T00:00:00Z", action: "block", clientRequestPath: "/b" })).not.toBe(a);
  });

  it("drops malformed events instead of guessing", () => {
    expect(toRow("o", "z", { action: "block" })).toBeNull();
    expect(toRow("o", "z", { datetime: "not a date", action: "block" })).toBeNull();
    expect(toRow("o", "z", { datetime: "2026-10-27T00:00:00Z", action: "block" })).toMatchObject({ action: "block", country: null });
  });

  it("groups actions conservatively", () => {
    expect(actionGroup("block")).toBe("blocked");
    expect(actionGroup("managed_challenge")).toBe("challenged");
    expect(actionGroup("skip")).toBe("allowed");
    expect(actionGroup("something_new")).toBe("other");
  });
});

describe("Cloudflare client input safety", () => {
  it("rejects tokens that are not API-token shaped (e.g. a Global API Key with an email)", () => {
    expect(() => new CloudflareClient("me@example.com:abc")).toThrow();
    expect(() => new CloudflareClient("x".repeat(10))).toThrow();
    expect(() => new CloudflareClient("a".repeat(40))).not.toThrow();
  });
});

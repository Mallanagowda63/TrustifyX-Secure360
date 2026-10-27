import { describe, expect, it } from "vitest";
import { decideRoute, PORTAL_LOGIN_ROUTE, safeNextPath } from "@/lib/site-routing";
import { aggregatePosture, postureScore } from "@/server/services/posture";
import { siteIndicators } from "@/server/services/portal";
import { GET as siteRedirect } from "@/app/sso/site-redirect/[site]/[target]/route";
import { NextRequest } from "next/server";

describe("two-site routing", () => {
  it("serves marketing pages on the marketing host and sends portal pages to the portal", () => {
    for (const p of ["/", "/signup", "/login", "/checkout", "/account", "/account/billing", "/legal/terms", "/about"]) {
      expect(decideRoute("MARKETING", p)).toEqual({ action: "next" });
    }
    expect(decideRoute("MARKETING", "/dashboard")).toEqual({ action: "redirect", site: "PORTAL", path: "/" });
    for (const p of ["/websites", "/websites/abc", "/findings", "/check", "/billing", "/settings", "/forgot-password", "/reset-password"]) {
      expect(decideRoute("MARKETING", p)).toEqual({ action: "redirect", site: "PORTAL", path: p });
    }
    expect(decideRoute("MARKETING", PORTAL_LOGIN_ROUTE)).toMatchObject({ action: "redirect", site: "PORTAL", path: "/login" });
  });

  it("portal: dashboard at /, own login page, no signup/pricing/checkout", () => {
    expect(decideRoute("PORTAL", "/")).toEqual({ action: "rewrite", path: "/dashboard" });
    expect(decideRoute("PORTAL", "/login")).toEqual({ action: "rewrite", path: PORTAL_LOGIN_ROUTE });
    expect(decideRoute("PORTAL", PORTAL_LOGIN_ROUTE)).toMatchObject({ action: "redirect", site: "PORTAL" });
    expect(decideRoute("PORTAL", "/signup")).toEqual({ action: "redirect", site: "MARKETING", path: "/#pricing" });
    expect(decideRoute("PORTAL", "/checkout")).toEqual({ action: "redirect", site: "MARKETING", path: "/#pricing" });
    expect(decideRoute("PORTAL", "/account/billing")).toEqual({ action: "redirect", site: "MARKETING", path: "/account/billing" });
    expect(decideRoute("PORTAL", "/legal/privacy")).toMatchObject({ action: "redirect", site: "MARKETING" });
    expect(decideRoute("PORTAL", "/random-page")).toEqual({ action: "notFound" });
    for (const p of ["/websites", "/check", "/findings", "/assistant", "/incidents", "/reports", "/billing", "/settings", "/forgot-password"]) {
      expect(decideRoute("PORTAL", p)).toEqual({ action: "next" });
    }
  });

  it("shared endpoints (API, SSO, metadata) are served on both hosts", () => {
    for (const site of ["PORTAL", "MARKETING"] as const) {
      for (const p of ["/api/auth/login", "/api/webhooks/razorpay", "/sso/begin", "/sso/callback", "/.well-known/security.txt", "/_next/static/x.js"]) {
        expect(decideRoute(site, p)).toEqual({ action: "next" });
      }
    }
  });
});

describe("cross-site redirect route", () => {
  const go = async (site: string, path: string) => {
    const target = Buffer.from(path, "utf8").toString("base64url");
    const res = await siteRedirect(new NextRequest("http://localhost:3000/"), { params: Promise.resolve({ site, target }) });
    return res.headers.get("location");
  };

  it("redirects only to the configured websites, keeping the path and query", async () => {
    expect(await go("MARKETING", "/#pricing")).toBe(`${process.env.APP_URL}/#pricing`);
    expect(await go("PORTAL", "/check?site=abc")).toBe(`${process.env.PORTAL_URL}/check?site=abc`);
    expect(await go("SOMEWHERE", "/x")).toBe(`${process.env.APP_URL}/x`);
  });

  it.each(["//evil.example/", "/\\evil.example", "https://evil.example/", "/a\r\nSet-Cookie: x=1"])("refuses unsafe path %s", async (path) => {
    expect(await go("PORTAL", path)).toBe(`${process.env.PORTAL_URL}/`);
  });
});

describe("redirect destination validation (open-redirect protection)", () => {
  it.each([
    ["https://evil.example/", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/api/auth/me", "/"],
    ["/sso/callback?code=x", "/"],
    ["/signup", "/"], // marketing page is not a portal destination
    ["/login", "/"],
    ["/check?site=abc", "/check?site=abc"],
    ["/websites/abc#tls", "/websites/abc#tls"],
    ["/", "/"],
  ])("portal next %s → %s", (input, expected) => {
    expect(safeNextPath("PORTAL", input, "/")).toBe(expected);
  });

  it("marketing destinations exclude portal pages", () => {
    expect(safeNextPath("MARKETING", "/account/billing", "/")).toBe("/account/billing");
    expect(safeNextPath("MARKETING", "/websites", "/account")).toBe("/account");
  });
});

describe("security posture score", () => {
  it("is not shown before a configuration check", () => {
    expect(postureScore(["HIGH"], false)).toBeNull();
  });

  it("subtracts documented weights per open finding and floors at 0", () => {
    expect(postureScore([], true)).toMatchObject({ score: 100, grade: "Strong" });
    expect(postureScore(["MEDIUM", "LOW", "LOW", "INFO"], true)).toMatchObject({ score: 81, grade: "Fair", deductions: { MEDIUM: 1, LOW: 2, INFO: 1 } });
    expect(postureScore(["CRITICAL", "HIGH", "HIGH"], true)).toMatchObject({ score: 20, grade: "Needs attention" });
    expect(postureScore(["CRITICAL", "CRITICAL", "CRITICAL"], true)?.score).toBe(0);
  });

  it("aggregates per website", () => {
    expect(aggregatePosture([postureScore([], true), postureScore(["MEDIUM", "MEDIUM"], true), null])?.score).toBe(90);
    expect(aggregatePosture([null])).toBeNull();
  });
});

describe("website status indicators", () => {
  const base = { status: "CONNECTED", state: "UP", pausedReason: null, lastAvailabilityCheckAt: new Date(), lastConfigCheckAt: new Date() } as const;

  it("maps stored state to the portal indicators", () => {
    expect(siteIndicators({ ...base }, true, 0)).toEqual(["WEBSITE_ONLINE", "MONITORING_ACTIVE"]);
    expect(siteIndicators({ ...base, state: "DOWN" }, true, 2)).toEqual(["WEBSITE_OFFLINE", "MONITORING_ACTIVE", "SECURITY_FINDING_DETECTED"]);
    expect(siteIndicators({ ...base, state: "UNKNOWN", lastConfigCheckAt: null }, true, 0)).toEqual(["INITIAL_SCAN_RUNNING", "MONITORING_ACTIVE"]);
    expect(siteIndicators({ ...base, status: "PENDING_VERIFICATION" }, true, 0)).toEqual(["VERIFICATION_REQUIRED"]);
    expect(siteIndicators({ ...base, status: "MONITORING_PAUSED", pausedReason: "USER" }, true, 0)).toEqual(["MONITORING_PAUSED"]);
    expect(siteIndicators({ ...base, status: "MONITORING_PAUSED", pausedReason: "SUBSCRIPTION_INACTIVE" }, false, 0)).toEqual(["SUBSCRIPTION_INACTIVE"]);
  });
});

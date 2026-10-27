import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { createSession } from "@/server/auth/session";
import { setCloudflareFetch } from "@/server/integrations/cloudflare/client";
import {
  applyChanges,
  connectCloudflare,
  disconnectCloudflare,
  discoverZones,
  enforceFeature,
  linkZone,
  previewChanges,
  protectionOverview,
  revertFeature,
  syncZone,
} from "@/server/protection/service";
import { eventSummary, syncZoneEvents } from "@/server/protection/events";
import { addonEntitlement, getEntitlement } from "@/server/billing/entitlements";
import { setBillingGateway } from "@/server/billing/gateway";
import { startCheckout } from "@/server/billing/service";
import { FakeRazorpay } from "../helpers/fake-razorpay";
import { POST as connectRoute } from "@/app/api/protection/connect/route";
import { GET as overviewRoute } from "@/app/api/protection/route";
import { hasTestDb, grantPlan, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";
import { baseZone, makeFakeCloudflare, zoneId, type FakeZone } from "../fixtures/fake-cloudflare";

// All Cloudflare responses in this file come from the labelled in-memory fixture, not a live account.
const TOKEN = "cf_test_token_abcdefghijklmnopqrstuvwxyz0123";

async function protectedOrg(name = "Shop") {
  const o = await makeOrg(name, "OWNER", { plan: "GROWTH" });
  await grantPlan(o.org.id, "PROTECT");
  return o;
}

function useFake(zones: FakeZone[], extra: Partial<Parameters<typeof makeFakeCloudflare>[0]> = {}) {
  const fake = makeFakeCloudflare({ token: TOKEN, zones, ...extra });
  setCloudflareFetch((u, i) => fake.fetch(u, i));
  return fake;
}

async function linked(zone: Partial<FakeZone> = {}, extra: Partial<Parameters<typeof makeFakeCloudflare>[0]> = {}) {
  const o = await protectedOrg();
  const site = await makeConnectedSite(o.org.id, "www.shop.example");
  const fz = baseZone({ id: zoneId(1), name: "shop.example", dns: [{ id: "d1", type: "A", name: "www.shop.example", content: "203.0.113.10", proxied: true }], ...zone });
  const fake = useFake([fz], extra);
  await connectCloudflare(o.actor, TOKEN);
  const row = await linkZone(o.actor, site.id, fz.id);
  return { ...o, site, fz, fake, zoneRef: row.id };
}

describe.skipIf(!hasTestDb)("Cloudflare protection (against a test fixture)", () => {
  beforeAll(migrateTestDb);
  beforeEach(resetDb);
  afterEach(() => setCloudflareFetch(null));

  it("connect: token verified with Cloudflare, stored encrypted, never returned", async () => {
    const o = await protectedOrg();
    useFake([baseZone({ id: zoneId(1), name: "shop.example" })]);
    await expect(connectCloudflare(o.actor, "short")).rejects.toMatchObject({ code: "invalid_token_format" });
    await expect(connectCloudflare(o.actor, "wrong_token_abcdefghijklmnopqrstuvwxyz0123")).rejects.toMatchObject({ code: "cloudflare_token_invalid" });
    expect(await prisma.cloudflareConnection.count()).toBe(0);

    const res = await connectCloudflare(o.actor, TOKEN);
    expect(res.zones.map((z) => z.name)).toEqual(["shop.example"]);
    const conn = await prisma.cloudflareConnection.findUniqueOrThrow({ where: { orgId: o.org.id } });
    expect(conn.tokenEnc).toMatch(/^v1\./);
    expect(conn.tokenEnc).not.toContain(TOKEN);
    expect(conn.tokenHint).toBe(TOKEN.slice(-4));
    const overview = await protectionOverview(o.org.id);
    expect(JSON.stringify(overview)).not.toContain(TOKEN);
    expect(JSON.stringify(overview)).not.toContain(conn.tokenEnc);
    expect((await prisma.integration.findFirstOrThrow({ where: { orgId: o.org.id, type: "CLOUDFLARE_WAF" } })).status).toBe("CONNECTED");
    expect(await prisma.protectionChangeAudit.count({ where: { orgId: o.org.id, action: "CONNECT", result: "SUCCEEDED" } })).toBe(1);
  });

  it("connect refuses disabled tokens and tokens that cannot read zones", async () => {
    const o = await protectedOrg();
    useFake([], { tokenStatus: "disabled" });
    await expect(connectCloudflare(o.actor, TOKEN)).rejects.toMatchObject({ code: "cloudflare_token_invalid" });
    useFake([], { deny: ["zone"] });
    await expect(connectCloudflare(o.actor, TOKEN)).rejects.toMatchObject({ code: "cloudflare_missing_permission" });
  });

  it("requires the Protect add-on, an active base plan and an admin role (server-side)", async () => {
    useFake([]);
    const noAddon = await makeOrg("NoAddon", "OWNER", { plan: "GROWTH" });
    await expect(connectCloudflare(noAddon.actor, TOKEN)).rejects.toMatchObject({ status: 402, code: "protect_required" });
    const unpaid = await makeOrg("Unpaid", "OWNER", { plan: null });
    await grantPlan(unpaid.org.id, "PROTECT"); // add-on alone does not count without a base plan
    await expect(connectCloudflare(unpaid.actor, TOKEN)).rejects.toMatchObject({ status: 402, code: "subscription_required" });

    const o = await protectedOrg("Team");
    const viewer = await prisma.user.create({ data: { email: "viewer@team.example", name: "V", passwordHash: "x" } });
    await prisma.membership.create({ data: { userId: viewer.id, orgId: o.org.id, role: "VIEWER" } });
    const s = await createSession({ userId: viewer.id, orgId: o.org.id, site: "PORTAL" });
    const headers = { host: "portal.localhost:3000", origin: "http://portal.localhost:3000", cookie: `tx_session=${s.token}; tx_csrf=${s.csrfToken}`, "x-csrf-token": s.csrfToken, "content-type": "application/json" };
    const res = await connectRoute(new NextRequest("http://portal.localhost:3000/api/protection/connect", { method: "POST", headers, body: JSON.stringify({ token: TOKEN }) }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    // Viewers may read the overview, which never includes credentials.
    const ov = await overviewRoute(new NextRequest("http://portal.localhost:3000/api/protection", { headers }), { params: Promise.resolve({}) });
    expect(ov.status).toBe(200);
  });

  it("the Protect add-on never counts as a base plan and cannot be bought as one", async () => {
    const o = await makeOrg("AddonOnly", "OWNER", { plan: null });
    await grantPlan(o.org.id, "PROTECT");
    expect((await getEntitlement(o.org.id)).active).toBe(false);
    expect(await addonEntitlement(o.org.id, "PROTECT")).toMatchObject({ active: false, baseActive: false });
    await grantPlan(o.org.id, "STARTER");
    expect((await getEntitlement(o.org.id)).plan?.code).toBe("STARTER");
    expect((await addonEntitlement(o.org.id, "PROTECT")).active).toBe(true);

    setBillingGateway(new FakeRazorpay());
    const buyer = await makeOrg("Buyer", "OWNER", { plan: null });
    await expect(startCheckout(buyer.actor, { planCode: "PROTECT", cycle: "MONTHLY" })).rejects.toMatchObject({ code: "invalid_plan" });
  });

  it("zone matching: only verified websites, only a zone that serves the hostname, tenant-scoped", async () => {
    const o = await protectedOrg();
    const site = await makeConnectedSite(o.org.id, "www.shop.example");
    const pending = await prisma.website.create({ data: { orgId: o.org.id, hostname: "new.shop.example", url: "https://new.shop.example/", displayName: "n", verificationToken: "t" } });
    useFake([baseZone({ id: zoneId(1), name: "shop.example" }), baseZone({ id: zoneId(2), name: "other.example" })]);
    await connectCloudflare(o.actor, TOKEN);

    const d = await discoverZones(o.actor);
    expect(d.websites.find((w) => w.id === site.id)?.candidates).toEqual([zoneId(1)]);
    expect(d.websites.some((w) => w.id === pending.id)).toBe(false);

    await expect(linkZone(o.actor, site.id, zoneId(2))).rejects.toMatchObject({ code: "zone_mismatch" });
    await expect(linkZone(o.actor, pending.id, zoneId(1))).rejects.toMatchObject({ code: "website_not_verified" });
    await expect(linkZone(o.actor, site.id, zoneId(9))).rejects.toMatchObject({ status: 502 }); // not visible to the token

    const other = await protectedOrg("Other");
    await expect(linkZone(other.actor, site.id, zoneId(1))).rejects.toMatchObject({ status: 404 }); // other tenant's website
    const row = await linkZone(o.actor, site.id, zoneId(1));
    expect(row.status).toBe("active");
  });

  it("plan limits and missing permissions are shown, never shown as enabled", async () => {
    const { org } = await linked({ plan: "free" });
    let f = (await protectionOverview(org.id)).zones[0].features;
    expect(f.find((x) => x.key === "managed_waf")).toMatchObject({ availability: "UNAVAILABLE_PLAN", state: "NOT_ENABLED" });
    expect(f.find((x) => x.key === "bot_fight_mode")).toMatchObject({ availability: "AVAILABLE", state: "NOT_ENABLED" });
    expect(f.find((x) => x.key === "always_use_https")).toMatchObject({ availability: "AVAILABLE", state: "NOT_ENABLED" });

    await resetDb();
    const pro = await linked({ plan: "pro" }, { deny: ["bots"] });
    f = (await protectionOverview(pro.org.id)).zones[0].features;
    expect(f.find((x) => x.key === "managed_waf")).toMatchObject({ availability: "AVAILABLE" });
    expect(f.find((x) => x.key === "bot_fight_mode")).toMatchObject({ availability: "UNAVAILABLE_PLAN" });

    await resetDb();
    const noWaf = await linked({ plan: "business" }, { deny: ["waf"] });
    f = (await protectionOverview(noWaf.org.id)).zones[0].features;
    expect(f.find((x) => x.key === "rule:sensitive_files")).toMatchObject({ availability: "MISSING_PERMISSION" });
  });

  it("preview changes nothing; apply needs the reviewed fingerprint and verifies by reading back", async () => {
    const customerRule = { id: "c".repeat(32), action: "block", expression: '(ip.src eq 198.51.100.1)', description: "Customer rule", enabled: true };
    const { actor, zoneRef, fz, fake } = await linked({ rulesets: { http_request_firewall_custom: { id: "f".repeat(32), rules: [customerRule] } } });
    const writesBefore = fake.writes.length;
    const p = await previewChanges(actor, zoneRef, ["always_use_https", "min_tls_1_2", "rule:sensitive_files"]);
    expect(fake.writes.length).toBe(writesBefore);
    expect(p.changes.find((c) => c.key === "always_use_https")).toMatchObject({ applicable: true, before: "off", after: "on" });
    expect(p.changes.find((c) => c.key === "min_tls_1_2")?.caution).toBeTruthy();

    await expect(applyChanges(actor, zoneRef, { keys: p.changes.map((c) => c.key), mode: "enforce", fingerprint: "0".repeat(64), confirm: true })).rejects.toMatchObject({ code: "preview_stale" });
    expect(fake.writes.length).toBe(writesBefore);

    const { results } = await applyChanges(actor, zoneRef, { keys: p.changes.map((c) => c.key), mode: "enforce", fingerprint: p.fingerprint, confirm: true });
    expect(results.map((r) => r.result)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    expect(fz.settings.always_use_https).toBe("on");
    expect(fz.settings.min_tls_version).toBe("1.2");
    const rules = fz.rulesets.http_request_firewall_custom.rules;
    expect(rules[0]).toEqual(customerRule); // customer rule untouched
    expect(rules[1]).toMatchObject({ action: "block", enabled: true, description: "[TrustifyX Secure360] Block access to sensitive files" });

    const cfg = await prisma.protectionConfiguration.findMany({ where: { zoneRefId: zoneRef }, orderBy: { feature: "asc" } });
    expect(cfg.map((c) => [c.feature, c.status])).toEqual([["always_use_https", "ACTIVE"], ["min_tls_1_2", "ACTIVE"], ["rule:sensitive_files", "ACTIVE"]]);
    expect(cfg.find((c) => c.feature === "always_use_https")?.previous).toBe("off");
    expect(await prisma.protectionChangeAudit.count({ where: { zoneRefId: zoneRef, action: "APPLY", result: "SUCCEEDED" } })).toBe(3);

    // Re-applying is a no-op: already enabled by TrustifyX.
    const again = await previewChanges(actor, zoneRef, ["always_use_https"]);
    expect(again.changes[0]).toMatchObject({ applicable: false, reason: "Already enabled by TrustifyX." });
  });

  it("success is only reported after Cloudflare shows the new configuration", async () => {
    const { actor, zoneRef } = await linked({}, { ignoreSettingWrites: true });
    const p = await previewChanges(actor, zoneRef, ["always_use_https"]);
    const { results } = await applyChanges(actor, zoneRef, { keys: ["always_use_https"], mode: "enforce", fingerprint: p.fingerprint, confirm: true });
    expect(results[0].result).toBe("VERIFY_FAILED");
    const cfg = await prisma.protectionConfiguration.findFirstOrThrow({ where: { zoneRefId: zoneRef } });
    expect(cfg.status).toBe("FAILED");
    expect(cfg.verifiedAt).toBeNull();
  });

  it("preview (non-blocking) rules, then enforce, then revert only TrustifyX rules", async () => {
    const customerRule = { id: "c".repeat(32), action: "managed_challenge", expression: "true", description: "Mine", enabled: true };
    const { actor, zoneRef, fz } = await linked({ rulesets: { http_request_firewall_custom: { id: "f".repeat(32), rules: [customerRule] } } });
    const p = await previewChanges(actor, zoneRef, ["rule:wp_xmlrpc", "always_use_https"], "preview");
    expect(p.changes.find((c) => c.key === "always_use_https")?.applicable).toBe(false); // settings have no preview mode
    await applyChanges(actor, zoneRef, { keys: ["rule:wp_xmlrpc", "always_use_https"], mode: "preview", fingerprint: p.fingerprint, confirm: true });
    const ours = fz.rulesets.http_request_firewall_custom.rules[1];
    expect(ours).toMatchObject({ enabled: false });
    expect((await prisma.protectionConfiguration.findFirstOrThrow({ where: { feature: "rule:wp_xmlrpc" } })).status).toBe("PREVIEW");

    await enforceFeature(actor, zoneRef, "rule:wp_xmlrpc");
    expect(fz.rulesets.http_request_firewall_custom.rules[1]).toMatchObject({ enabled: true, expression: '(http.request.uri.path eq "/xmlrpc.php")', action: "block" });

    await revertFeature(actor, zoneRef, "rule:wp_xmlrpc");
    expect(fz.rulesets.http_request_firewall_custom.rules).toEqual([customerRule]);
    await expect(revertFeature(actor, zoneRef, "rule:wp_xmlrpc")).rejects.toMatchObject({ code: "not_managed" });
  });

  it("reverting a setting restores the value recorded before TrustifyX changed it", async () => {
    const { actor, zoneRef, fz } = await linked({ settings: { always_use_https: "off", min_tls_version: "1.1", ssl: "full" } });
    const p = await previewChanges(actor, zoneRef, ["min_tls_1_2"]);
    await applyChanges(actor, zoneRef, { keys: ["min_tls_1_2"], mode: "enforce", fingerprint: p.fingerprint, confirm: true });
    expect(fz.settings.min_tls_version).toBe("1.2");
    await revertFeature(actor, zoneRef, "min_tls_1_2");
    expect(fz.settings.min_tls_version).toBe("1.1");
  });

  it("Cloudflare plan limits: rule quota and managed WAF entitlement are respected", async () => {
    const full = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`.repeat(32).slice(0, 32), action: "block", expression: "true", description: `r${i}`, enabled: true }));
    const { actor, zoneRef } = await linked({ plan: "free", rulesets: { http_request_firewall_custom: { id: "f".repeat(32), rules: full } } });
    const p = await previewChanges(actor, zoneRef, ["rule:sensitive_files", "managed_waf"]);
    expect(p.changes.find((c) => c.key === "rule:sensitive_files")).toMatchObject({ applicable: false });
    expect(p.changes.find((c) => c.key === "rule:sensitive_files")?.reason).toContain("5 custom rules");
    expect(p.changes.find((c) => c.key === "managed_waf")).toMatchObject({ applicable: false });

    await resetDb();
    const pro = await linked({ plan: "pro" });
    const pp = await previewChanges(pro.actor, pro.zoneRef, ["managed_waf"]);
    const { results } = await applyChanges(pro.actor, pro.zoneRef, { keys: ["managed_waf"], mode: "enforce", fingerprint: pp.fingerprint, confirm: true });
    expect(results[0].result).toBe("SUCCEEDED");
    expect(pro.fz.rulesets.http_request_firewall_managed.rules[0]).toMatchObject({ action: "execute", action_parameters: { id: "efb7b8c949ac4650a09736fc376e9aee" } });
  });

  it("DDoS/proxy status and origin exposure come from DNS facts", async () => {
    const { org } = await linked({
      dns: [
        { id: "1", type: "A", name: "www.shop.example", content: "203.0.113.10", proxied: true },
        { id: "2", type: "A", name: "direct.shop.example", content: "203.0.113.10", proxied: false },
        { id: "3", type: "A", name: "mail.shop.example", content: "198.51.100.7", proxied: false },
      ],
    });
    const z = (await protectionOverview(org.id)).zones[0];
    expect(z.ddos.edgeProtected).toBe(true);
    expect(z.ddos.warnings.join(" ")).toContain("direct.shop.example");
    expect(z.ddos.warnings.join(" ")).not.toContain("mail.shop.example");

    await resetDb();
    const grey = await linked({ dns: [{ id: "1", type: "A", name: "www.shop.example", content: "203.0.113.10", proxied: false }] });
    const g = (await protectionOverview(grey.org.id)).zones[0];
    expect(g.ddos.edgeProtected).toBe(false);
    expect(g.ddos.warnings.join(" ")).toContain("not proxied");
  });

  it("security events: only available fields are queried, duplicates are skipped, coverage is recorded", async () => {
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const events = [
      { datetime: iso(50), action: "block", source: "firewallCustom", rayName: "ray1", ruleId: "r1", clientCountryName: "US", clientRequestPath: "/.env", clientRequestHTTPHost: "www.shop.example" },
      { datetime: iso(40), action: "managed_challenge", source: "firewallCustom", rayName: "ray2", ruleId: "r2", clientCountryName: "IN", clientRequestPath: "/wp-login.php", clientRequestHTTPHost: "www.shop.example" },
      { datetime: iso(30), action: "block", source: "firewallManaged", rayName: "ray3", ruleId: "r3", clientCountryName: "US", clientRequestPath: "/x", clientRequestHTTPHost: "www.shop.example" },
    ];
    const limited = ["datetime", "action", "source", "ruleId", "clientCountryName", "clientRequestPath"]; // no rayName, no IP
    const { org, zoneRef, fake } = await linked({ events, requests24h: 1234 }, { availableFields: limited });

    const first = await syncZoneEvents(zoneRef);
    expect(first).toMatchObject({ imported: 3, error: null });
    const eventsQuery = fake.graphqlQueries.find((q) => q.includes("firewallEventsAdaptive("))!;
    expect(eventsQuery).not.toContain("rayName");
    expect(eventsQuery).not.toContain("clientIP");
    expect((await syncZoneEvents(zoneRef)).imported).toBe(0); // de-duplicated

    const zone = await prisma.cloudflareZone.findUniqueOrThrow({ where: { id: zoneRef } });
    expect(zone.eventCoverage).toMatchObject({ enabled: true, notOlderThan: 2678400, requests24h: 1234 });
    const summary = await eventSummary(org.id, { days: 7 });
    expect(summary.total).toBe(3);
    expect(summary.totals).toMatchObject({ blocked: 2, challenged: 1 });
    expect(summary.topCountries[0]).toEqual({ country: "US", count: 2 });

    const other = await protectedOrg("Other");
    expect((await eventSummary(other.org.id)).total).toBe(0); // tenant isolation
  });

  it("shows 'unavailable' instead of inventing numbers when events cannot be read", async () => {
    const { org, zoneRef } = await linked({}, { eventsEnabled: false });
    expect(await syncZoneEvents(zoneRef)).toMatchObject({ imported: 0, error: "unavailable" });
    const z = await prisma.cloudflareZone.findUniqueOrThrow({ where: { id: zoneRef } });
    expect(z.eventsError).toBe("Security event data unavailable for the connected Cloudflare plan or permissions.");
    expect((await eventSummary(org.id)).total).toBe(0);

    await resetDb();
    const denied = await linked({}, { deny: ["analytics"] });
    const r = await syncZoneEvents(denied.zoneRef);
    expect(r.imported).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("cross-tenant: another organization cannot preview, apply or revert this zone", async () => {
    const { zoneRef } = await linked();
    const other = await protectedOrg("Attacker");
    await expect(previewChanges(other.actor, zoneRef, ["always_use_https"])).rejects.toMatchObject({ status: 404 });
    await expect(revertFeature(other.actor, zoneRef, "always_use_https")).rejects.toMatchObject({ status: 404 });
    await expect(enforceFeature(other.actor, zoneRef, "rule:wp_xmlrpc")).rejects.toMatchObject({ status: 404 });
  });

  it("a revoked token marks the connection invalid; disconnect removes TrustifyX rules, token and events", async () => {
    const { actor, org, zoneRef, fz, fake } = await linked({ events: [{ datetime: new Date().toISOString(), action: "block", rayName: "r1" }] });
    const p = await previewChanges(actor, zoneRef, ["rule:sensitive_files"]);
    await applyChanges(actor, zoneRef, { keys: ["rule:sensitive_files"], mode: "enforce", fingerprint: p.fingerprint, confirm: true });
    await syncZoneEvents(zoneRef);
    expect(await prisma.securityEvent.count()).toBe(1);

    fake.opts.token = "rotated_elsewhere_abcdefghijklmnopqrstuvw";
    await expect(syncZone(zoneRef)).rejects.toMatchObject({ code: "cloudflare_token_invalid" });
    expect((await prisma.cloudflareConnection.findUniqueOrThrow({ where: { orgId: org.id } })).status).toBe("INVALID");
    fake.opts.token = TOKEN;

    await prisma.cloudflareConnection.update({ where: { orgId: org.id }, data: { status: "ACTIVE" } });
    const out = await disconnectCloudflare(actor, { removeTrustifyxChanges: true });
    expect(out.failures).toEqual([]);
    expect(fz.rulesets.http_request_firewall_custom.rules).toEqual([]);
    expect(await prisma.cloudflareConnection.count()).toBe(0);
    expect(await prisma.cloudflareZone.count()).toBe(0);
    expect(await prisma.securityEvent.count()).toBe(0);
    expect((await prisma.integration.findFirstOrThrow({ where: { orgId: org.id } })).status).toBe("NOT_CONNECTED");
  });
});

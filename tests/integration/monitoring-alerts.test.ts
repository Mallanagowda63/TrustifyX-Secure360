import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { setMailTransport, type MailMessage } from "@/server/alerts/mailer";
import { dispatchAlert } from "@/server/alerts/notify";
import { runAvailabilityCheck, runConfigCheck } from "@/server/monitoring/run";
import type { AvailabilityResult } from "@/server/monitoring/availability";
import { analyzeHeaders } from "@/server/monitoring/headers";
import { hasTestDb, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";
import { hardenedObservation, tls } from "../helpers/fixtures";

const up: AvailabilityResult = { success: true, statusCode: 200, responseTimeMs: 120, redirectCount: 0, finalUrl: "https://x/", attempts: 1, error: null };
const down: AvailabilityResult = { success: false, statusCode: null, responseTimeMs: null, redirectCount: 0, finalUrl: null, attempts: 2, error: "TIMEOUT: Request timed out" };
const check = (r: AvailabilityResult) => ({ check: async () => r });

describe.skipIf(!hasTestDb)("monitoring, downtime alerts and deduplication", () => {
  let sent: MailMessage[];
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    sent = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
  });
  afterEach(() => setMailTransport(null));

  it("confirms downtime only after consecutive failures, alerts once, then sends one recovery", async () => {
    const { org } = await makeOrg("Ops");
    const site = await makeConnectedSite(org.id);

    await runAvailabilityCheck(site.id, check(up));
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).state).toBe("UP");

    // 1st failure: not yet confirmed (threshold = 2)
    await runAvailabilityCheck(site.id, check(down));
    expect(sent).toHaveLength(0);
    expect((await prisma.website.findUniqueOrThrow({ where: { id: site.id } })).state).toBe("UP");

    // 2nd failure: confirmed → one incident, one alert
    const r2 = await runAvailabilityCheck(site.id, check(down));
    expect(r2).toMatchObject({ state: "DOWN", transitioned: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^\[DOWN\]/);

    // Further failures while down: no duplicate alerts or incidents
    await runAvailabilityCheck(site.id, check(down));
    await runAvailabilityCheck(site.id, check(down));
    expect(sent).toHaveLength(1);
    expect(await prisma.incident.count({ where: { websiteId: site.id, type: "DOWNTIME" } })).toBe(1);

    // Recovery: incident resolved and exactly one recovery notification
    await runAvailabilityCheck(site.id, check(up));
    await runAvailabilityCheck(site.id, check(up));
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toMatch(/^\[RECOVERED\]/);
    const inc = await prisma.incident.findFirstOrThrow({ where: { websiteId: site.id } });
    expect(inc.resolvedAt).not.toBeNull();
    expect(await prisma.availabilityCheck.count({ where: { websiteId: site.id } })).toBe(7);
  });

  it("a single transient failure never alerts", async () => {
    const { org } = await makeOrg("Blip");
    const site = await makeConnectedSite(org.id);
    for (const r of [up, down, up, down, up]) await runAvailabilityCheck(site.id, check(r));
    expect(sent).toHaveLength(0);
    expect(await prisma.incident.count()).toBe(0);
  });

  it("never checks websites that are unverified, paused or lack authorization", async () => {
    const { org } = await makeOrg("Guard");
    const base = await makeConnectedSite(org.id);
    let called = 0;
    const spy = { check: async () => (called++, up) };
    for (const data of [
      { status: "PENDING_VERIFICATION" as const },
      { status: "VERIFICATION_FAILED" as const },
      { status: "MONITORING_PAUSED" as const },
      { status: "CONNECTED" as const, authorizationConfirmedAt: null },
      { status: "CONNECTED" as const, verifiedAt: null, authorizationConfirmedAt: new Date() },
    ]) {
      await prisma.website.update({ where: { id: base.id }, data });
      expect(await runAvailabilityCheck(base.id, spy)).toEqual({ skipped: true });
      expect(await runConfigCheck(base.id, { collect: async () => hardenedObservation() })).toEqual({ skipped: true });
    }
    expect(called).toBe(0);
  });

  it("deduplicates alerts per (event, recipient) even when dispatched repeatedly", async () => {
    const { org, user } = await makeOrg("Dedupe");
    const second = await prisma.user.create({ data: { email: "second@example.com", name: "Second", passwordHash: "x" } });
    await prisma.membership.create({ data: { userId: second.id, orgId: org.id, role: "VIEWER" } });
    const params = { orgId: org.id, type: "DOWNTIME" as const, kind: "downtime" as const, dedupeKey: "down:test-incident", subject: "s", text: "t" };
    const first = await dispatchAlert(params);
    const again = await Promise.all([dispatchAlert(params), dispatchAlert(params)]);
    expect(first.sent).toBe(2);
    expect(again.reduce((a, r) => a + r.sent, 0)).toBe(0);
    expect(again.reduce((a, r) => a + r.duplicates, 0)).toBe(4);
    expect(sent.map((m) => m.to).sort()).toEqual([user.email, "second@example.com"].sort());
  });

  it("respects notification preferences", async () => {
    const { org, user } = await makeOrg("Prefs");
    await prisma.notificationPreference.create({ data: { orgId: org.id, userId: user.id, emailDowntime: false, findingMinSeverity: "HIGH" } });
    const site = await makeConnectedSite(org.id);
    await runAvailabilityCheck(site.id, check(down));
    await runAvailabilityCheck(site.id, check(down));
    expect(sent).toHaveLength(0);
    // MEDIUM findings are below this user's HIGH threshold
    await runConfigCheck(site.id, { collect: async () => hardenedObservation({ headers: analyzeHeaders("https://x/", 200, { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'" }) }) });
    expect(sent).toHaveLength(0);
    expect(await prisma.finding.count({ where: { websiteId: site.id } })).toBe(1);
  });

  it("records SKIPPED alerts honestly when SMTP is not configured", async () => {
    setMailTransport(null);
    const { org } = await makeOrg("NoSmtp");
    const r = await dispatchAlert({ orgId: org.id, type: "DOWNTIME", kind: "downtime", dedupeKey: "k1", subject: "s", text: "t" });
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect((await prisma.alert.findFirstOrThrow()).status).toBe("SKIPPED");
  });

  it("findings lifecycle: open → alert, resolved when fixed, reopened on regression, false positive respected", async () => {
    const { org, user } = await makeOrg("Find");
    const site = await makeConnectedSite(org.id);
    const noHsts = hardenedObservation({
      headers: analyzeHeaders("https://x/", 200, {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      }),
    });

    const r1 = await runConfigCheck(site.id, { collect: async () => noHsts });
    expect(r1).toMatchObject({ opened: 1 });
    expect(sent.at(-1)?.subject).toMatch(/\[MEDIUM\] New finding .*HSTS/);
    const f = await prisma.finding.findFirstOrThrow({ where: { websiteId: site.id } });
    expect(f).toMatchObject({ ruleId: "headers.hsts_missing", status: "OPEN" });

    // Same observation again: no duplicate finding or alert
    await runConfigCheck(site.id, { collect: async () => noHsts });
    expect(await prisma.finding.count()).toBe(1);
    expect(sent).toHaveLength(1);

    // Header check fails this time: the finding must NOT be auto-resolved
    await runConfigCheck(site.id, { collect: async () => ({ ...noHsts, headers: null, errors: { headers: "TIMEOUT" } }) });
    expect((await prisma.finding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("OPEN");

    // Fixed → resolved + resolution alert
    const r3 = await runConfigCheck(site.id, { collect: async () => hardenedObservation() });
    expect(r3).toMatchObject({ resolved: 1 });
    expect((await prisma.finding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("RESOLVED");
    expect(sent.at(-1)?.subject).toMatch(/^\[RESOLVED\]/);

    // Regression → reopened
    const r4 = await runConfigCheck(site.id, { collect: async () => noHsts });
    expect(r4).toMatchObject({ reopened: 1 });
    expect((await prisma.finding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("OPEN");

    // Customer marks false positive → stays false positive on later scans
    await prisma.finding.update({ where: { id: f.id }, data: { status: "FALSE_POSITIVE", statusChangedById: user.id } });
    await runConfigCheck(site.id, { collect: async () => noHsts });
    expect((await prisma.finding.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("FALSE_POSITIVE");
  });

  it("sends each TLS expiry threshold once per certificate and records config changes", async () => {
    const { org } = await makeOrg("Tls");
    const site = await makeConnectedSite(org.id);
    const at = (days: number, fp = "AA:BB") => hardenedObservation({ tls: tls({ daysRemaining: days, fingerprint256: fp, validTo: new Date(Date.now() + days * 86_400_000).toISOString() }) });

    await runConfigCheck(site.id, { collect: async () => at(29) });
    await runConfigCheck(site.id, { collect: async () => at(28) });
    const tlsAlerts = () => sent.filter((m) => m.subject.startsWith("[TLS]"));
    expect(tlsAlerts()).toHaveLength(1); // 30-day threshold, once
    await runConfigCheck(site.id, { collect: async () => at(13) });
    expect(tlsAlerts()).toHaveLength(2); // 14-day threshold
    // Renewed certificate: no further expiry alerts, and the change is recorded
    await runConfigCheck(site.id, { collect: async () => at(89, "NEW:FP") });
    expect(tlsAlerts()).toHaveLength(2);
    const changes = await prisma.configChange.findMany({ where: { websiteId: site.id, field: "fingerprint256" } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ previousValue: "AA:BB", newValue: "NEW:FP" });
  });
});

describe.skipIf(!hasTestDb)("incident cleanup when monitoring stops", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    setMailTransport({ send: async () => undefined });
  });
  afterEach(() => setMailTransport(null));

  it("pausing a site that is down closes its open downtime incident", async () => {
    const { org, actor } = await makeOrg("Pause");
    const site = await makeConnectedSite(org.id);
    await runAvailabilityCheck(site.id, check(down));
    await runAvailabilityCheck(site.id, check(down));
    expect(await prisma.incident.count({ where: { websiteId: site.id, resolvedAt: null } })).toBe(1);
    const { updateWebsite } = await import("@/server/services/websites");
    await updateWebsite({ ...actor, role: "ADMIN" }, site.id, { paused: true });
    const inc = await prisma.incident.findFirstOrThrow({ where: { websiteId: site.id } });
    expect(inc.resolvedAt).not.toBeNull();
    expect(inc.details).toMatchObject({ closedBecause: "monitoring paused" });
  });
});

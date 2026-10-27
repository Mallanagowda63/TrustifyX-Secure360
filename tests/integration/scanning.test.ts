import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { prisma } from "@/server/db";
import { queue, QUEUES } from "@/server/queue";
import { redis } from "@/server/redis";
import {
  cancelScan,
  ingestScanResult,
  markScanFailed,
  requestScan,
  scanMaintenance,
  setSchedule,
} from "@/server/scanning/service";
import { applyJobOutcome } from "@/server/scanning/jobs";
import type { ScanAlert } from "@/server/scanning/zap-report";
import { hasTestDb, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";

const alert = (over: Partial<ScanAlert> = {}): ScanAlert => ({
  pluginId: "10038",
  alertRef: "10038-1",
  name: "Content Security Policy (CSP) Header Not Set",
  risk: "MEDIUM",
  confidence: "HIGH",
  description: "CSP is an added layer of security.",
  solution: "Set the header.",
  reference: null,
  cweId: 693,
  wascId: 15,
  instances: [{ uri: "https://www.shop.example/", method: "GET", param: null, evidence: null }],
  instanceCount: 1,
  ...over,
});

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe.skipIf(!hasTestDb)("vulnerability scanning: authorization, limits and results", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    await queue(QUEUES.scans).obliterate({ force: true });
  });
  afterAll(async () => {
    await queue(QUEUES.scans).obliterate({ force: true });
  });

  it("passive scans need a verified website and explicit authorization; the statement is stored", async () => {
    const o = await makeOrg("Shop", "OWNER", { plan: "GROWTH" });
    const site = await makeConnectedSite(o.org.id, "www.shop.example");
    const pending = await prisma.website.create({ data: { orgId: o.org.id, hostname: "new.shop.example", url: "https://new.shop.example/", displayName: "n", verificationToken: "t" } });

    await expect(requestScan(o.actor, { websiteId: site.id, type: "PASSIVE", confirmAuthorization: false })).rejects.toMatchObject({ code: "authorization_required" });
    await expect(requestScan(o.actor, { websiteId: pending.id, type: "PASSIVE", confirmAuthorization: true })).rejects.toMatchObject({ code: "website_not_verified" });

    const scan = await requestScan(o.actor, { websiteId: site.id, type: "PASSIVE", confirmAuthorization: true });
    expect(scan).toMatchObject({ status: "QUEUED", type: "PASSIVE", targetUrl: "https://www.shop.example/", trigger: "MANUAL" });
    expect(scan.authorizationText).toContain("passive baseline scan of https://www.shop.example/ only");
    const job = await queue(QUEUES.scans).getJob(`scan_${scan.id}`);
    expect(job?.data).toMatchObject({ scanId: scan.id, targetUrl: "https://www.shop.example/", type: "PASSIVE" });
    expect(await prisma.auditLog.count({ where: { action: "scan.passive_authorized", targetId: scan.id } })).toBe(1);

    // One scan in flight per organization.
    const other = await makeConnectedSite(o.org.id, "blog.shop.example");
    await expect(requestScan(o.actor, { websiteId: other.id, type: "PASSIVE", confirmAuthorization: true })).rejects.toMatchObject({ code: "scan_in_progress" });
  });

  it("roles, plans and tenants are enforced server-side", async () => {
    const viewerOrg = await makeOrg("Team", "VIEWER", { plan: "BUSINESS" });
    const site = await makeConnectedSite(viewerOrg.org.id, "www.team.example");
    await expect(requestScan(viewerOrg.actor, { websiteId: site.id, type: "PASSIVE", confirmAuthorization: true })).rejects.toMatchObject({ status: 403 });

    const unpaid = await makeOrg("Unpaid", "OWNER", { plan: null });
    const unpaidSite = await makeConnectedSite(unpaid.org.id, "www.unpaid.example");
    await expect(requestScan(unpaid.actor, { websiteId: unpaidSite.id, type: "PASSIVE", confirmAuthorization: true })).rejects.toMatchObject({ status: 402 });

    const attacker = await makeOrg("Attacker", "OWNER", { plan: "BUSINESS" });
    await expect(requestScan(attacker.actor, { websiteId: site.id, type: "PASSIVE", confirmAuthorization: true })).rejects.toMatchObject({ status: 404 });

    const starter = await makeOrg("Small", "OWNER", { plan: "STARTER" });
    const s = await makeConnectedSite(starter.org.id, "www.small.example");
    await expect(
      requestScan(starter.actor, { websiteId: s.id, type: "ACTIVE", confirmAuthorization: true, confirmHostname: "www.small.example", windowStart: inHours(1), windowEnd: inHours(2) }),
    ).rejects.toMatchObject({ code: "plan_limit" });
  });

  it("active scans require the typed hostname and a bounded future maintenance window", async () => {
    const o = await makeOrg("Biz", "OWNER", { plan: "BUSINESS" });
    const site = await makeConnectedSite(o.org.id, "www.biz.example");
    const base = { websiteId: site.id, type: "ACTIVE" as const, confirmAuthorization: true };
    await expect(requestScan(o.actor, { ...base, confirmHostname: "biz.example", windowStart: inHours(1), windowEnd: inHours(2) })).rejects.toMatchObject({ code: "hostname_confirmation" });
    await expect(requestScan(o.actor, { ...base, confirmHostname: "www.biz.example" })).rejects.toMatchObject({ code: "window_required" });
    await expect(requestScan(o.actor, { ...base, confirmHostname: "www.biz.example", windowStart: inHours(1), windowEnd: inHours(6) })).rejects.toMatchObject({ code: "invalid_window" });
    await expect(requestScan(o.actor, { ...base, confirmHostname: "www.biz.example", windowStart: inHours(-3), windowEnd: inHours(-2) })).rejects.toMatchObject({ code: "invalid_window" });

    const scan = await requestScan(o.actor, { ...base, confirmHostname: "WWW.BIZ.EXAMPLE", windowStart: inHours(24), windowEnd: inHours(26) });
    expect(scan.authorizationText).toContain("ACTIVE vulnerability scan");
    const job = await queue(QUEUES.scans).getJob(`scan_${scan.id}`);
    expect(await job?.getState()).toBe("delayed"); // released only when the window opens

    // Cancelling before the window removes the job.
    await cancelScan(o.actor, scan.id);
    expect((await prisma.vulnerabilityScan.findUniqueOrThrow({ where: { id: scan.id } })).status).toBe("CANCELLED");
    expect(await queue(QUEUES.scans).getJob(`scan_${scan.id}`)).toBeUndefined();
  });

  it("monthly allowance per plan", async () => {
    const o = await makeOrg("Small", "OWNER", { plan: "STARTER" });
    const site = await makeConnectedSite(o.org.id, "www.small.example");
    for (let i = 0; i < 4; i++) {
      await prisma.vulnerabilityScan.create({ data: { orgId: o.org.id, websiteId: site.id, type: "PASSIVE", status: "COMPLETED", targetUrl: "https://www.small.example/", authorizationText: "x", authorizedAt: new Date(), createdAt: new Date(Date.now() - (i + 2) * 3600_000) } });
    }
    await expect(requestScan(o.actor, { websiteId: site.id, type: "PASSIVE", confirmAuthorization: true })).rejects.toMatchObject({ code: "plan_limit" });
  });

  it("results are stored once, through the queue, from the scanner's return value", async () => {
    const o = await makeOrg("Shop", "OWNER", { plan: "GROWTH" });
    const site = await makeConnectedSite(o.org.id, "www.shop.example");
    const scan = await requestScan(o.actor, { websiteId: site.id, type: "PASSIVE", confirmAuthorization: true });

    // Stand-in for the isolated scanner process (labelled fake: returns fixed alerts, runs no scan).
    const worker = new Worker(QUEUES.scans, async () => ({ alerts: [alert(), alert({ pluginId: "10021", alertRef: "10021", name: "X-Content-Type-Options Header Missing", risk: "LOW" })], stats: { allowed: 12, refused: 3 } }), { connection: redis().duplicate() });
    await new Promise<void>((resolve) => worker.on("completed", () => resolve()));
    await worker.close();

    expect(await applyJobOutcome(scan.id)).toBe("completed");
    expect(await applyJobOutcome(scan.id)).toBe("completed"); // idempotent
    const done = await prisma.vulnerabilityScan.findUniqueOrThrow({ where: { id: scan.id }, include: { findings: true } });
    expect(done).toMatchObject({ status: "COMPLETED", alertCount: 2, progress: 100 });
    expect(done.findings).toHaveLength(2);
    expect(done.stats).toMatchObject({ refused: 3 });
    await ingestScanResult(scan.id, { alerts: [alert()], stats: {} });
    expect(await prisma.vulnerabilityFinding.count({ where: { scanId: scan.id } })).toBe(2);
  });

  it("failures, cancellations, stuck scans and missed windows are recorded honestly", async () => {
    const o = await makeOrg("Biz", "OWNER", { plan: "BUSINESS" });
    const site = await makeConnectedSite(o.org.id, "www.biz.example");
    const mk = (data: object) => prisma.vulnerabilityScan.create({ data: { orgId: o.org.id, websiteId: site.id, type: "PASSIVE", targetUrl: "https://www.biz.example/", authorizationText: "x", authorizedAt: new Date(), ...data } });

    const failed = await mk({ status: "RUNNING", startedAt: new Date() });
    await markScanFailed(failed.id, "ZAP did not produce a JSON report");
    expect(await prisma.vulnerabilityScan.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "FAILED", error: "ZAP did not produce a JSON report" });

    const cancelled = await mk({ status: "RUNNING", startedAt: new Date(), cancelRequestedAt: new Date() });
    await markScanFailed(cancelled.id, "Scan cancelled by the customer");
    expect((await prisma.vulnerabilityScan.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe("CANCELLED");

    const stuck = await mk({ status: "RUNNING", startedAt: new Date(Date.now() - 3 * 3600_000) });
    const missed = await mk({ status: "QUEUED", type: "ACTIVE", windowStart: new Date(Date.now() - 7200_000), windowEnd: new Date(Date.now() - 3600_000) });
    const r = await scanMaintenance();
    expect(r).toMatchObject({ timedOut: 1, expired: 1 });
    expect((await prisma.vulnerabilityScan.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("FAILED");
    expect((await prisma.vulnerabilityScan.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe("CANCELLED");
  });

  it("schedules run passive scans under the stored authorization, and stop if the authorizer leaves", async () => {
    const o = await makeOrg("Shop", "OWNER", { plan: "GROWTH" });
    const site = await makeConnectedSite(o.org.id, "www.shop.example");
    await expect(setSchedule(o.actor, { websiteId: site.id, frequency: "WEEKLY", confirmAuthorization: false })).rejects.toMatchObject({ code: "authorization_required" });
    const schedule = await setSchedule(o.actor, { websiteId: site.id, frequency: "WEEKLY", confirmAuthorization: true });
    expect(schedule?.authorizationText).toContain("recurring weekly passive scans");

    await prisma.scanSchedule.update({ where: { websiteId: site.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect((await scanMaintenance()).scheduled).toBe(1);
    const scan = await prisma.vulnerabilityScan.findFirstOrThrow({ where: { websiteId: site.id } });
    expect(scan).toMatchObject({ trigger: "SCHEDULED", type: "PASSIVE" });
    expect((await prisma.scanSchedule.findUniqueOrThrow({ where: { websiteId: site.id } })).nextRunAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    await prisma.vulnerabilityScan.update({ where: { id: scan.id }, data: { status: "COMPLETED" } });
    await prisma.membership.deleteMany({ where: { userId: o.user.id } });
    await prisma.scanSchedule.update({ where: { websiteId: site.id }, data: { nextRunAt: new Date(Date.now() - 1000) } });
    expect((await scanMaintenance()).scheduled).toBe(0);
  });
});

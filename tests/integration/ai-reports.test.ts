import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { setAiProvider, type AiRequest } from "@/server/ai/provider";
import { ask, explainFinding, prioritize } from "@/server/ai/assistant";
import { setMailTransport, type MailMessage } from "@/server/alerts/mailer";
import { buildReportSummary, previousPeriod } from "@/server/reports/data";
import { renderReportPdf } from "@/server/reports/pdf";
import { runScheduledReports } from "@/server/reports/scheduled";
import { listIntegrations } from "@/server/integrations/catalog";
import { hasTestDb, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";

async function seedFinding(orgId: string, websiteId: string, title = "HSTS missing") {
  return prisma.finding.create({
    data: {
      orgId,
      websiteId,
      ruleId: `r-${title}`,
      category: "headers",
      title,
      severity: "MEDIUM",
      evidence: { observedAt: "2026-10-01T00:00:00Z", header: "Strict-Transport-Security", observed: null },
      description: "d",
      remediation: "add header",
    },
  });
}

describe.skipIf(!hasTestDb)("AI assistant (fake provider)", () => {
  let prompts: AiRequest[];
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    prompts = [];
    setAiProvider({
      name: "fake",
      model: "fake-1",
      complete: async (req) => {
        prompts.push(req);
        return "Fix HSTS first. Also see CVE-2099-0001.";
      },
    });
  });
  afterEach(() => setAiProvider(undefined));

  it("explains a finding using only sanitised data and stores the interaction", async () => {
    const { org, actor, user } = await makeOrg("Ai");
    const site = await makeConnectedSite(org.id);
    const f = await seedFinding(org.id, site.id);
    const r = await explainFinding(actor, f.id);
    expect(r.answer).toContain("Fix HSTS first");
    expect(r.answer).not.toContain("CVE-2099-0001"); // invented CVE removed
    const prompt = prompts[0].user;
    expect(prompt).toContain("<data>");
    expect(prompt).toContain(site.hostname);
    expect(prompt).not.toContain(site.verificationToken);
    expect(prompt).not.toContain(user.email);
    expect(await prisma.aiInteraction.count({ where: { orgId: org.id, kind: "explain_finding" } })).toBe(1);
  });

  it("never exposes another organization's data to the model", async () => {
    const a = await makeOrg("A");
    const b = await makeOrg("B");
    const siteA = await makeConnectedSite(a.org.id, "alpha.example.com");
    const siteB = await makeConnectedSite(b.org.id, "bravo-secret.example.com");
    await seedFinding(a.org.id, siteA.id, "Alpha finding");
    const fb = await seedFinding(b.org.id, siteB.id, "Bravo finding");

    await expect(explainFinding(a.actor, fb.id)).rejects.toMatchObject({ status: 404 });
    await expect(ask(a.actor, { question: "what's up?", websiteId: siteB.id })).rejects.toMatchObject({ status: 404 });
    await prioritize(a.actor);
    await ask(a.actor, { question: "Summarise everything" });
    for (const p of prompts) {
      expect(p.user).not.toContain("bravo-secret");
      expect(p.user).not.toContain("Bravo finding");
    }
  });

  it("returns a clear 503 when AI is not configured", async () => {
    setAiProvider(null);
    const { org, actor } = await makeOrg("Off");
    await makeConnectedSite(org.id);
    await expect(prioritize(actor)).rejects.toMatchObject({ status: 503, code: "ai_disabled" });
  });
});

describe.skipIf(!hasTestDb)("reports", () => {
  let sent: MailMessage[];
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    sent = [];
    setMailTransport({ send: async (m) => void sent.push(m) });
    setAiProvider(null);
  });
  afterEach(() => {
    setMailTransport(null);
    setAiProvider(undefined);
  });

  it("summarises real data for the period and renders a PDF", async () => {
    const { org } = await makeOrg("Rep");
    const site = await makeConnectedSite(org.id, "report.example.com");
    const now = Date.now();
    const checks = [true, true, true, false].map((success, i) => ({
      orgId: org.id,
      websiteId: site.id,
      success,
      statusCode: success ? 200 : 503,
      responseTimeMs: success ? 100 + i * 100 : null,
      checkedAt: new Date(now - (i + 1) * 3600_000),
    }));
    await prisma.availabilityCheck.createMany({ data: checks });
    await seedFinding(org.id, site.id);
    const summary = await buildReportSummary(org.id, "WEEKLY", new Date(now - 7 * 86_400_000), new Date(Date.now() + 60_000));
    expect(summary.totals).toMatchObject({ checks: 4, uptimePercent: 75, findingsOpened: 1 });
    expect(summary.sites[0]).toMatchObject({ hostname: "report.example.com", avgResponseMs: 200 });
    const pdf = await renderReportPdf(summary, null);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it("scheduled reports are generated and emailed once per period, only to opted-in members", async () => {
    const { org, user } = await makeOrg("Sched");
    await makeConnectedSite(org.id);
    const optedOut = await prisma.user.create({ data: { email: "no-reports@example.com", name: "No", passwordHash: "x" } });
    await prisma.membership.create({ data: { userId: optedOut.id, orgId: org.id, role: "VIEWER" } });
    await prisma.notificationPreference.create({ data: { orgId: org.id, userId: optedOut.id, emailMonthlyReport: false } });

    const now = new Date("2026-11-01T07:00:00Z");
    const first = await runScheduledReports("MONTHLY", now);
    const second = await runScheduledReports("MONTHLY", now);
    expect(first.generated).toBe(1);
    expect(second.generated).toBe(0);
    expect(await prisma.report.count({ where: { orgId: org.id } })).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(user.email);
    expect(sent[0].attachments?.[0].contentType).toBe("application/pdf");
    const r = await prisma.report.findFirstOrThrow();
    expect(r.periodStart.toISOString()).toBe(previousPeriod("MONTHLY", now).start.toISOString());
  });
});

describe.skipIf(!hasTestDb)("integrations", () => {
  beforeAll(migrateTestDb);
  beforeEach(resetDb);

  it("lists every advanced integration as Not Connected with no invented data", async () => {
    const { org } = await makeOrg("Int");
    const list = await listIntegrations(org.id);
    expect(list.map((i) => i.type).sort()).toEqual(["CLOUDFLARE_WAF", "GITHUB", "OWASP_ZAP", "WAZUH"]);
    for (const i of list) {
      expect(i.status).toBe("NOT_CONNECTED");
      expect(i.lastSyncAt).toBeNull();
      expect(Object.keys(i)).not.toContain("eventCount");
    }
  });
});

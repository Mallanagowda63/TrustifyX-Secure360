import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { createSession, sessionCookieName } from "@/server/auth/session";
import { ApiError } from "@/server/api";
import { deleteWebsite, getWebsiteForOrg, listWebsites, requestScan, updateWebsite } from "@/server/services/websites";
import { getFinding, listFindings, updateFindingStatus } from "@/server/services/findings";
import { dashboardData } from "@/server/services/dashboard";
import { changeMemberRole, removeMember } from "@/server/services/auth";
import { GET as getWebsiteRoute, DELETE as deleteWebsiteRoute } from "@/app/api/websites/[id]/route";
import { GET as listWebsitesRoute, POST as createWebsiteRoute } from "@/app/api/websites/route";
import { PATCH as patchFindingRoute } from "@/app/api/findings/[id]/route";
import { hasTestDb, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";

const APP = "http://localhost:3000";

async function sessionFor(userId: string, orgId: string) {
  return createSession({ userId, orgId });
}

function req(method: string, path: string, s: { token: string; csrfToken: string } | null, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { origin: APP, ...headers };
  if (s) {
    h.cookie = `${sessionCookieName()}=${s.token}`;
    if (method !== "GET") h["x-csrf-token"] = s.csrfToken;
  }
  if (body !== undefined) h["content-type"] = "application/json";
  return new NextRequest(`${APP}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

describe.skipIf(!hasTestDb)("tenant isolation", () => {
  beforeAll(migrateTestDb);
  beforeEach(resetDb);

  async function twoTenants() {
    const a = await makeOrg("Alice");
    const b = await makeOrg("Bob");
    const siteA = await makeConnectedSite(a.org.id, "alice-shop.example.com");
    const siteB = await makeConnectedSite(b.org.id, "bob-shop.example.com");
    const findingB = await prisma.finding.create({
      data: {
        orgId: b.org.id,
        websiteId: siteB.id,
        ruleId: "headers.hsts_missing",
        category: "headers",
        title: "HSTS missing",
        severity: "MEDIUM",
        evidence: {},
        description: "d",
        remediation: "r",
      },
    });
    await prisma.availabilityCheck.create({ data: { orgId: b.org.id, websiteId: siteB.id, success: true, statusCode: 200, responseTimeMs: 100 } });
    return { a, b, siteA, siteB, findingB };
  }

  it("service layer never returns another organization's data", async () => {
    const { a, siteB, findingB } = await twoTenants();
    expect((await listWebsites(a.org.id)).map((w) => w.hostname)).toEqual(["alice-shop.example.com"]);
    expect(await listFindings(a.org.id)).toEqual([]);
    await expect(getWebsiteForOrg(a.org.id, siteB.id)).rejects.toMatchObject({ status: 404 });
    await expect(getFinding(a.org.id, findingB.id)).rejects.toMatchObject({ status: 404 });
    const dash = await dashboardData(a.org.id);
    expect(dash.totals.websites).toBe(1);
    expect(dash.uptime30d.checks).toBe(0);
  });

  it("service layer refuses cross-tenant mutations", async () => {
    const { a, siteB, findingB } = await twoTenants();
    await expect(updateWebsite(a.actor, siteB.id, { displayName: "pwned" })).rejects.toBeInstanceOf(ApiError);
    await expect(deleteWebsite(a.actor, siteB.id)).rejects.toMatchObject({ status: 404 });
    await expect(requestScan(a.actor, siteB.id, async () => undefined)).rejects.toMatchObject({ status: 404 });
    await expect(updateFindingStatus(a.actor, findingB.id, { status: "RESOLVED" })).rejects.toMatchObject({ status: 404 });
    const still = await prisma.website.findUnique({ where: { id: siteB.id } });
    expect(still?.displayName).toBe("bob-shop.example.com");
    expect((await prisma.finding.findUnique({ where: { id: findingB.id } }))?.status).toBe("OPEN");
  });

  it("team management is scoped to the actor's organization", async () => {
    const { a, b } = await twoTenants();
    const bMembership = await prisma.membership.findFirstOrThrow({ where: { orgId: b.org.id } });
    await expect(changeMemberRole(a.actor, bMembership.id, "VIEWER")).rejects.toMatchObject({ status: 404 });
    await expect(removeMember(a.actor, bMembership.id)).rejects.toMatchObject({ status: 404 });
  });

  it("REST API: a session from org A gets 404 for org B's website and cannot delete it", async () => {
    const { a, siteB } = await twoTenants();
    const s = await sessionFor(a.user.id, a.org.id);
    const res = await getWebsiteRoute(req("GET", `/api/websites/${siteB.id}`, s), params({ id: siteB.id }));
    expect(res.status).toBe(404);
    const del = await deleteWebsiteRoute(req("DELETE", `/api/websites/${siteB.id}`, s), params({ id: siteB.id }));
    expect(del.status).toBe(404);
    expect(await prisma.website.count({ where: { id: siteB.id } })).toBe(1);
  });

  it("REST API: switching activeOrgId to a foreign org in the session does not grant access", async () => {
    const { a, b, siteB } = await twoTenants();
    const s = await sessionFor(a.user.id, b.org.id); // forged: user A is not a member of org B
    const res = await listWebsitesRoute(req("GET", "/api/websites", s), params({}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.websites.map((w: { id: string }) => w.id)).not.toContain(siteB.id);
  });

  it("REST API: findings of another org cannot be updated", async () => {
    const { a, findingB } = await twoTenants();
    const s = await sessionFor(a.user.id, a.org.id);
    const res = await patchFindingRoute(req("PATCH", `/api/findings/${findingB.id}`, s, { status: "FALSE_POSITIVE", note: "x" }), params({ id: findingB.id }));
    expect(res.status).toBe(404);
  });

  it("REST API: requires authentication", async () => {
    const res = await listWebsitesRoute(req("GET", "/api/websites", null), params({}));
    expect(res.status).toBe(401);
  });

  it("REST API: rejects state-changing requests without a valid CSRF token or from another origin", async () => {
    const { a } = await twoTenants();
    const s = await sessionFor(a.user.id, a.org.id);
    const noToken = await createWebsiteRoute(req("POST", "/api/websites", { ...s, csrfToken: "" }, { url: "example.com" }), params({}));
    expect(noToken.status).toBe(403);
    const wrongToken = await createWebsiteRoute(req("POST", "/api/websites", { ...s, csrfToken: "forged" }, { url: "example.com" }), params({}));
    expect(wrongToken.status).toBe(403);
    const crossOrigin = await createWebsiteRoute(req("POST", "/api/websites", s, { url: "example.com" }, { origin: "https://evil.example" }), params({}));
    expect(crossOrigin.status).toBe(403);
    expect(await prisma.website.count({ where: { orgId: a.org.id, hostname: "example.com" } })).toBe(0);
    const ok = await createWebsiteRoute(req("POST", "/api/websites", s, { url: "example.com" }), params({}));
    expect(ok.status).toBe(201);
  });

  it("REST API: enforces role permissions (viewer cannot add or delete websites)", async () => {
    const v = await makeOrg("Victor", "VIEWER");
    const site = await makeConnectedSite(v.org.id);
    const s = await sessionFor(v.user.id, v.org.id);
    expect((await createWebsiteRoute(req("POST", "/api/websites", s, { url: "example.org" }), params({}))).status).toBe(403);
    expect((await deleteWebsiteRoute(req("DELETE", `/api/websites/${site.id}`, s), params({ id: site.id }))).status).toBe(403);
    expect((await getWebsiteRoute(req("GET", `/api/websites/${site.id}`, s), params({ id: site.id }))).status).toBe(200);
  });

  it("REST API: SSRF-unsafe URLs are rejected at website creation", async () => {
    const { a } = await twoTenants();
    const s = await sessionFor(a.user.id, a.org.id);
    for (const url of ["https://169.254.169.254", "https://localhost", "http://example.com", "https://10.0.0.1", "https://db.internal"]) {
      const res = await createWebsiteRoute(req("POST", "/api/websites", s, { url }), params({}));
      expect(res.status, url).toBe(400);
    }
  });
});

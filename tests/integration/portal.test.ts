import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { createSession } from "@/server/auth/session";
import { setMailTransport, type MailMessage } from "@/server/alerts/mailer";
import { accessStatus, portalDashboard } from "@/server/services/portal";
import { sha256 } from "@/server/security/crypto";
import { GET as ssoBegin } from "@/app/sso/begin/route";
import { GET as ssoAuthorize } from "@/app/sso/authorize/route";
import { GET as ssoCallback } from "@/app/sso/callback/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { POST as forgotRoute } from "@/app/api/auth/forgot-password/route";
import { POST as resetRoute } from "@/app/api/auth/reset-password/route";
import { GET as dashboardApi } from "@/app/api/dashboard/route";
import { POST as createWebsiteRoute } from "@/app/api/websites/route";
import { GET as websitesRoute } from "@/app/api/websites/route";
import { hasTestDb, makeConnectedSite, makeOrg, migrateTestDb, resetDb } from "../helpers/db";
import { Browser, MKT, PORTAL, none, userWithPassword } from "../helpers/browser";

describe.skipIf(!hasTestDb)("security portal: unified identity and SSO", () => {
  let mail: MailMessage[];
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    mail = [];
    setMailTransport({ send: async (m) => void mail.push(m) });
  });
  afterEach(() => setMailTransport(null));

  it("the same account signs in on both websites; each site gets its own host-bound session", async () => {
    const { user } = await userWithPassword("asha@shop.example", "correct horse battery staple");
    const b = new Browser();
    for (const origin of [MKT, PORTAL]) {
      const res = b.absorb(origin, await loginRoute(b.req("POST", `${origin}/api/auth/login`, { email: "asha@shop.example", password: "correct horse battery staple" }), none));
      expect(res.status).toBe(200);
    }
    const sessions = await prisma.session.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(sessions.map((s) => s.site)).toEqual(["MARKETING", "PORTAL"]);
    expect(await prisma.user.count()).toBe(1); // no duplicate identities
  });

  it("a marketing session token is not accepted by the portal (and vice versa)", async () => {
    const { user, org } = await userWithPassword("a@x.example", "correct horse battery staple");
    const mk = await createSession({ userId: user.id, orgId: org.id, site: "MARKETING" });
    const stolen = new NextRequest(`${PORTAL}/api/dashboard`, { headers: { host: "portal.localhost:3000", cookie: `tx_session=${mk.token}` } });
    expect((await dashboardApi(stolen, none)).status).toBe(401);
    const ok = new NextRequest(`${MKT}/api/dashboard`, { headers: { host: "localhost:3000", cookie: `tx_session=${mk.token}` } });
    expect((await dashboardApi(ok, none)).status).toBe(200);
  });

  it("SSO: marketing → portal with a single-use, state-bound code; no token in any URL", async () => {
    const { user } = await userWithPassword("sso@x.example", "correct horse battery staple");
    const b = new Browser();
    b.absorb(MKT, await loginRoute(b.req("POST", `${MKT}/api/auth/login`, { email: "sso@x.example", password: "correct horse battery staple" }), none));

    // 1. portal /sso/begin sets the state cookie and sends the browser to marketing /sso/authorize
    const begin = await b.get(`${PORTAL}/sso/begin?next=%2Fcheck`, ssoBegin);
    expect(begin.status).toBe(303);
    const authorizeUrl = begin.headers.get("location")!;
    expect(authorizeUrl.startsWith(`${MKT}/sso/authorize?`)).toBe(true);
    expect(b.jar(PORTAL).get("tx_sso_state")).toBeTruthy();

    // 2. marketing issues a code bound to the state
    const auth = await b.get(authorizeUrl, ssoAuthorize);
    const callbackUrl = auth.headers.get("location")!;
    expect(callbackUrl.startsWith(`${PORTAL}/sso/callback?`)).toBe(true);
    const mkToken = b.jar(MKT).get("tx_session")!;
    expect(callbackUrl).not.toContain(mkToken);

    // 3. portal redeems it → new portal session, redirect to the validated next path
    const cb = await b.get(callbackUrl, ssoCallback);
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe(`${PORTAL}/check`);
    const portalToken = b.jar(PORTAL).get("tx_session")!;
    expect(portalToken).toBeTruthy();
    expect(portalToken).not.toBe(mkToken); // session rotation
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(new Set(sessions.map((s) => s.ssoGroupId)).size).toBe(1);

    // Replay of the same code fails.
    const replay = await b.get(callbackUrl, ssoCallback);
    expect(replay.headers.get("location")).toContain("/login?error=sso");
  });

  it("SSO login-CSRF: an attacker's code cannot be redeemed in a victim's browser", async () => {
    await userWithPassword("attacker@x.example", "correct horse battery staple");
    const attacker = new Browser();
    attacker.absorb(MKT, await loginRoute(attacker.req("POST", `${MKT}/api/auth/login`, { email: "attacker@x.example", password: "correct horse battery staple" }), none));
    const begin = await attacker.get(`${PORTAL}/sso/begin`, ssoBegin);
    const auth = await attacker.get(begin.headers.get("location")!, ssoAuthorize);
    const callbackUrl = auth.headers.get("location")!;

    const victim = new Browser(); // has no matching state cookie
    const res = await victim.get(callbackUrl, ssoCallback);
    expect(res.headers.get("location")).toContain("/login?error=sso");
    expect(victim.jar(PORTAL).get("tx_session")).toBeUndefined();
  });

  it("SSO without a marketing session sends the user to the portal login page", async () => {
    const b = new Browser();
    const begin = await b.get(`${PORTAL}/sso/begin?next=%2Ffindings`, ssoBegin);
    const auth = await b.get(begin.headers.get("location")!, ssoAuthorize);
    expect(auth.headers.get("location")).toBe(`${PORTAL}/login?next=%2Ffindings`);
  });

  it("SSO rejects expired codes and open-redirect destinations", async () => {
    await userWithPassword("exp@x.example", "correct horse battery staple");
    const b = new Browser();
    b.absorb(MKT, await loginRoute(b.req("POST", `${MKT}/api/auth/login`, { email: "exp@x.example", password: "correct horse battery staple" }), none));
    const begin = await b.get(`${PORTAL}/sso/begin?next=${encodeURIComponent("https://evil.example/")}`, ssoBegin);
    expect(new URL(begin.headers.get("location")!).searchParams.get("next")).toBe("/");
    const auth = await b.get(begin.headers.get("location")!, ssoAuthorize);
    const callbackUrl = auth.headers.get("location")!;
    await prisma.ssoCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await b.get(callbackUrl, ssoCallback)).headers.get("location")).toContain("/login?error=sso");
  });

  it("logout on the portal also ends the linked marketing session", async () => {
    await userWithPassword("out@x.example", "correct horse battery staple");
    const b = new Browser();
    b.absorb(MKT, await loginRoute(b.req("POST", `${MKT}/api/auth/login`, { email: "out@x.example", password: "correct horse battery staple" }), none));
    const begin = await b.get(`${PORTAL}/sso/begin`, ssoBegin);
    const auth = await b.get(begin.headers.get("location")!, ssoAuthorize);
    await b.get(auth.headers.get("location")!, ssoCallback);
    expect(await prisma.session.count()).toBe(2);
    await logoutRoute(b.req("POST", `${PORTAL}/api/auth/logout`), none);
    expect(await prisma.session.count()).toBe(0);
  });

  it("remember me off → browser-session cookie with shorter server lifetime", async () => {
    await userWithPassword("rm@x.example", "correct horse battery staple");
    const b = new Browser();
    const res = await loginRoute(b.req("POST", `${PORTAL}/api/auth/login`, { email: "rm@x.example", password: "correct horse battery staple", remember: false }), none);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("tx_session="))!;
    expect(cookie).not.toMatch(/expires=/i);
    const s = await prisma.session.findFirstOrThrow();
    expect(s.persistent).toBe(false);
    expect(s.expiresAt.getTime() - Date.now()).toBeLessThan(13 * 3600_000);
  });

  it("expired sessions are rejected", async () => {
    const { user, org } = await userWithPassword("old@x.example", "correct horse battery staple");
    const s = await createSession({ userId: user.id, orgId: org.id, site: "PORTAL" });
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const req = new NextRequest(`${PORTAL}/api/dashboard`, { headers: { host: "portal.localhost:3000", cookie: `tx_session=${s.token}` } });
    expect((await dashboardApi(req, none)).status).toBe(401);
  });

  it("no public signup on the portal; cross-site form posts are refused", async () => {
    const b = new Browser();
    const signup = await signupRoute(b.req("POST", `${PORTAL}/api/auth/signup`, { name: "X", email: "x@y.example", password: "correct horse battery staple", orgName: "X" }), none);
    expect(signup.status).toBe(404);
    // Marketing origin posting to the portal host (same registrable domain) is blocked.
    const { user, org } = await userWithPassword("cs@x.example", "correct horse battery staple");
    const s = await createSession({ userId: user.id, orgId: org.id, site: "PORTAL" });
    const req = new NextRequest(`${PORTAL}/api/websites`, {
      method: "POST",
      headers: { host: "portal.localhost:3000", origin: MKT, cookie: `tx_session=${s.token}`, "x-csrf-token": s.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ url: "example.com" }),
    });
    expect((await createWebsiteRoute(req, none)).status).toBe(403);
  });

  it("forgot/reset password: no enumeration, single-use token, all sessions revoked, works on both sites", async () => {
    const { user } = await userWithPassword("reset@x.example", "old password that is long");
    await createSession({ userId: user.id, orgId: null, site: "MARKETING" });
    const b = new Browser();
    const unknown = await (await forgotRoute(b.req("POST", `${PORTAL}/api/auth/forgot-password`, { email: "nobody@x.example" }), none)).json();
    const known = await (await forgotRoute(b.req("POST", `${PORTAL}/api/auth/forgot-password`, { email: "reset@x.example" }), none)).json();
    expect(unknown.message).toBe(known.message);
    expect(mail).toHaveLength(1);
    const link = mail[0].text.match(/https?:\/\/\S+reset-password\?token=(\S+)/)!;
    expect(link[0].startsWith(`${PORTAL}/reset-password`)).toBe(true);
    const token = decodeURIComponent(link[1]);
    expect(await prisma.passwordResetToken.findFirst({ where: { tokenHash: token } })).toBeNull(); // only hash stored
    expect(await prisma.passwordResetToken.findFirst({ where: { tokenHash: sha256(token) } })).not.toBeNull();

    expect((await resetRoute(b.req("POST", `${PORTAL}/api/auth/reset-password`, { token, password: "brand new long passphrase" }), none)).status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await resetRoute(b.req("POST", `${PORTAL}/api/auth/reset-password`, { token, password: "another long passphrase" }), none)).status).toBe(400);

    const oldPw = await loginRoute(b.req("POST", `${MKT}/api/auth/login`, { email: "reset@x.example", password: "old password that is long" }), none);
    expect(oldPw.status).toBe(401);
    for (const origin of [MKT, PORTAL]) {
      expect((await loginRoute(b.req("POST", `${origin}/api/auth/login`, { email: "reset@x.example", password: "brand new long passphrase" }), none)).status).toBe(200);
    }
  });

  it("expired reset tokens are refused", async () => {
    await userWithPassword("exp2@x.example", "old password that is long");
    const b = new Browser();
    await forgotRoute(b.req("POST", `${PORTAL}/api/auth/forgot-password`, { email: "exp2@x.example" }), none);
    const token = decodeURIComponent(mail[0].text.match(/token=(\S+)/)![1]);
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await resetRoute(b.req("POST", `${PORTAL}/api/auth/reset-password`, { token, password: "brand new long passphrase" }), none)).status).toBe(400);
  });
});

describe.skipIf(!hasTestDb)("security portal: subscription access and dashboard data", () => {
  beforeAll(migrateTestDb);
  beforeEach(resetDb);

  it("access states come from backend subscription records", async () => {
    const unpaid = await makeOrg("Unpaid", "OWNER", { plan: null });
    expect((await accessStatus(unpaid.org.id)).state).toBe("SUBSCRIPTION_REQUIRED");

    const plan = await prisma.pricingPlan.findUniqueOrThrow({ where: { code: "GROWTH" } }).catch(async () => {
      const { seedPlans } = await import("@/server/billing/plans");
      await seedPlans();
      return prisma.pricingPlan.findUniqueOrThrow({ where: { code: "GROWTH" } });
    });
    await prisma.subscription.create({ data: { orgId: unpaid.org.id, planId: plan.id, cycle: "MONTHLY", mode: "RECURRING", status: "PENDING_PAYMENT", amountPaise: 353_882, razorpaySubscriptionId: "sub_pending1" } });
    expect((await accessStatus(unpaid.org.id)).state).toBe("PAYMENT_PENDING");

    await prisma.subscription.create({
      data: { orgId: unpaid.org.id, planId: plan.id, cycle: "MONTHLY", mode: "RECURRING", status: "PAST_DUE", amountPaise: 353_882, currentPeriodEnd: new Date(Date.now() - 1000), graceUntil: new Date(Date.now() + 86_400_000) },
    });
    expect((await accessStatus(unpaid.org.id)).state).toBe("GRACE");

    const paid = await makeOrg("Paid", "OWNER", { plan: "GROWTH" });
    expect(await accessStatus(paid.org.id)).toMatchObject({ active: true, limits: { websites: 5, aiAssistant: true } });
  });

  it("dashboard shows only this organization's real data with correct indicators", async () => {
    const a = await makeOrg("A", "OWNER", { plan: "GROWTH" });
    const b = await makeOrg("B", "OWNER", { plan: "GROWTH" });
    const siteA = await makeConnectedSite(a.org.id, "alpha.example.com");
    await makeConnectedSite(b.org.id, "bravo.example.com");
    await prisma.website.create({ data: { orgId: a.org.id, hostname: "pending.example.com", url: "https://pending.example.com/", displayName: "Pending", verificationToken: "t" } });

    let d = await portalDashboard(a.org.id);
    expect(d.sites.map((s) => s.hostname).sort()).toEqual(["alpha.example.com", "pending.example.com"]);
    expect(d.sites.find((s) => s.hostname === "alpha.example.com")!.indicators).toContain("INITIAL_SCAN_RUNNING");
    expect(d.sites.find((s) => s.hostname === "pending.example.com")!.indicators).toEqual(["VERIFICATION_REQUIRED"]);
    expect(d.totals.posture).toBeNull(); // no configuration check yet → no score

    await prisma.website.update({ where: { id: siteA.id }, data: { state: "UP", lastAvailabilityCheckAt: new Date(), lastConfigCheckAt: new Date() } });
    await prisma.finding.create({ data: { orgId: a.org.id, websiteId: siteA.id, ruleId: "headers.hsts_missing", category: "headers", title: "HSTS missing", severity: "MEDIUM", evidence: {}, description: "d", remediation: "r" } });
    d = await portalDashboard(a.org.id);
    const alpha = d.sites.find((s) => s.hostname === "alpha.example.com")!;
    expect(alpha.indicators).toEqual(["WEBSITE_ONLINE", "MONITORING_ACTIVE", "SECURITY_FINDING_DETECTED"]);
    expect(alpha.posture?.score).toBe(90);
    expect(d.totals).toMatchObject({ websites: 2, monitored: 1, online: 1, openFindings: 1 });
  });

  it("portal API: unauthenticated and cross-organization access is refused", async () => {
    const a = await makeOrg("A", "OWNER", { plan: "GROWTH" });
    const b = await makeOrg("B", "OWNER", { plan: "GROWTH" });
    await makeConnectedSite(b.org.id, "bravo.example.com");
    const anon = new NextRequest(`${PORTAL}/api/websites`, { headers: { host: "portal.localhost:3000" } });
    expect((await websitesRoute(anon, none)).status).toBe(401);
    const s = await createSession({ userId: a.user.id, orgId: b.org.id, site: "PORTAL" }); // forged org
    const res = await websitesRoute(new NextRequest(`${PORTAL}/api/websites`, { headers: { host: "portal.localhost:3000", cookie: `tx_session=${s.token}` } }), none);
    expect((await res.json()).websites).toEqual([]);
  });

  it("unpaid customers cannot connect websites from the portal", async () => {
    const u = await makeOrg("Unpaid", "OWNER", { plan: null });
    const s = await createSession({ userId: u.user.id, orgId: u.org.id, site: "PORTAL" });
    const req = new NextRequest(`${PORTAL}/api/websites`, {
      method: "POST",
      headers: { host: "portal.localhost:3000", origin: PORTAL, cookie: `tx_session=${s.token}`, "x-csrf-token": s.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://shop.example.com" }),
    });
    const res = await createWebsiteRoute(req, none);
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("subscription_required");
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { setMailTransport, type MailMessage } from "@/server/alerts/mailer";
import { totpCode, totpStep } from "@/server/auth/totp";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as mfaVerifyRoute } from "@/app/api/auth/mfa/verify/route";
import { POST as resetRequestRoute } from "@/app/api/auth/mfa/reset-request/route";
import { POST as resetConfirmRoute } from "@/app/api/auth/mfa/reset-confirm/route";
import { POST as resetCancelRoute } from "@/app/api/auth/mfa/reset-cancel/route";
import { GET as mfaStatusRoute } from "@/app/api/account/mfa/route";
import { POST as setupRoute } from "@/app/api/account/mfa/setup/route";
import { POST as enableRoute } from "@/app/api/account/mfa/enable/route";
import { POST as disableRoute } from "@/app/api/account/mfa/disable/route";
import { POST as regenerateRoute } from "@/app/api/account/mfa/recovery-codes/route";
import { PATCH as orgPatchRoute } from "@/app/api/org/route";
import { GET as websitesRoute } from "@/app/api/websites/route";
import { GET as adminOrgsRoute } from "@/app/api/admin/organizations/route";
import { hasTestDb, migrateTestDb, resetDb } from "../helpers/db";
import { Browser, MKT, PORTAL, none, userWithPassword } from "../helpers/browser";

const PASSWORD = "correct horse battery staple";

async function signIn(b: Browser, origin: string, email: string) {
  return b.absorb(origin, await loginRoute(b.req("POST", `${origin}/api/auth/login`, { email, password: PASSWORD }), none));
}

/** Signs in (no 2FA yet) and enrolls; returns the secret and recovery codes. Enrollment uses the previous step's code. */
async function enroll(b: Browser, origin: string, email: string) {
  await signIn(b, origin, email);
  const setup = await (await setupRoute(b.req("POST", `${origin}/api/account/mfa/setup`, { password: PASSWORD }), none)).json();
  const secret = String(setup.secret).replace(/\s/g, "");
  const enable = b.absorb(origin, await enableRoute(b.req("POST", `${origin}/api/account/mfa/enable`, { code: totpCode(secret, totpStep() - 1) }), none));
  expect(enable.status).toBe(200);
  const { recoveryCodes } = await enable.json();
  return { secret, recoveryCodes: recoveryCodes as string[] };
}

describe.skipIf(!hasTestDb)("two-factor authentication (TOTP)", () => {
  let mail: MailMessage[];
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    mail = [];
    setMailTransport({ send: async (m) => void mail.push(m) });
  });
  afterEach(() => setMailTransport(null));

  it("enrollment: password re-check, encrypted secret, code confirmation, hashed recovery codes, session rotation", async () => {
    const { user } = await userWithPassword("asha@shop.example", PASSWORD);
    const b = new Browser();
    const other = new Browser();
    await signIn(other, MKT, "asha@shop.example"); // a second device
    await signIn(b, PORTAL, "asha@shop.example");

    expect((await setupRoute(b.req("POST", `${PORTAL}/api/account/mfa/setup`, { password: "wrong password!!" }), none)).status).toBe(401);
    const setupRes = await setupRoute(b.req("POST", `${PORTAL}/api/account/mfa/setup`, { password: PASSWORD }), none);
    const setup = await setupRes.json();
    expect(setup.qrSvg).toContain("<svg");
    const secret = setup.secret.replace(/\s/g, "");
    const pending = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.totpPendingEnc).toMatch(/^v1\./);
    expect(pending.totpPendingEnc).not.toContain(secret);
    expect(pending.totpEnabledAt).toBeNull(); // not active until confirmed

    const bad = await enableRoute(b.req("POST", `${PORTAL}/api/account/mfa/enable`, { code: "000000" }), none);
    expect(bad.status).toBe(400);

    const oldToken = b.jar(PORTAL).get("tx_session");
    const ok = b.absorb(PORTAL, await enableRoute(b.req("POST", `${PORTAL}/api/account/mfa/enable`, { code: totpCode(secret, totpStep()) }), none));
    expect(ok.status).toBe(200);
    const { recoveryCodes } = await ok.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const enabled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(enabled.totpEnabledAt).not.toBeNull();
    expect(enabled.totpSecretEnc).toMatch(/^v1\./);
    expect(enabled.totpPendingEnc).toBeNull();
    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    for (const c of recoveryCodes) expect(stored.some((s) => s.codeHash.includes(c))).toBe(false);

    // Session rotated; other device signed out.
    expect(b.jar(PORTAL).get("tx_session")).not.toBe(oldToken);
    expect((await mfaStatusRoute(b.req("GET", `${PORTAL}/api/account/mfa`), none)).status).toBe(200);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await mfaStatusRoute(other.req("GET", `${MKT}/api/account/mfa`), none)).status).toBe(401);

    const actions = (await prisma.auditLog.findMany({ where: { userId: user.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["mfa.enrollment_started", "mfa.enrollment_code_invalid", "mfa.enabled"]));
    expect(mail.some((m) => m.subject === "Two-factor authentication enabled")).toBe(true);
  });

  it("login requires the second factor; the password step alone never creates a session", async () => {
    const { user } = await userWithPassword("two@x.example", PASSWORD);
    const { secret } = await enroll(new Browser(), PORTAL, "two@x.example");
    await prisma.session.deleteMany({});

    const b = new Browser();
    const first = await signIn(b, PORTAL, "two@x.example");
    expect(await first.json()).toEqual({ mfaRequired: true });
    expect(b.jar(PORTAL).get("tx_session")).toBeUndefined();
    expect(b.jar(PORTAL).get("tx_mfa")).toBeTruthy();
    expect(await prisma.session.count()).toBe(0);

    const wrong = await mfaVerifyRoute(b.req("POST", `${PORTAL}/api/auth/mfa/verify`, { code: "123456" }), none);
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).code).toBe("invalid_code");

    const ok = b.absorb(PORTAL, await mfaVerifyRoute(b.req("POST", `${PORTAL}/api/auth/mfa/verify`, { code: totpCode(secret, totpStep()) }), none));
    expect(ok.status).toBe(200);
    expect(b.jar(PORTAL).get("tx_session")).toBeTruthy();
    expect(b.jar(PORTAL).get("tx_mfa")).toBeUndefined();
    expect(await prisma.session.count({ where: { userId: user.id, site: "PORTAL" } })).toBe(1);
    expect(await prisma.mfaChallenge.count()).toBe(0); // consumed
  });

  it("a code cannot be replayed, and recovery codes work exactly once", async () => {
    await userWithPassword("replay@x.example", PASSWORD);
    const { secret, recoveryCodes } = await enroll(new Browser(), MKT, "replay@x.example");
    const code = totpCode(secret, totpStep());

    const b1 = new Browser();
    await signIn(b1, MKT, "replay@x.example");
    expect((await mfaVerifyRoute(b1.req("POST", `${MKT}/api/auth/mfa/verify`, { code }), none)).status).toBe(200);

    const b2 = new Browser();
    await signIn(b2, MKT, "replay@x.example");
    const replay = await mfaVerifyRoute(b2.req("POST", `${MKT}/api/auth/mfa/verify`, { code }), none);
    expect(replay.status).toBe(401);
    // An older step than the last accepted one is rejected too.
    expect((await mfaVerifyRoute(b2.req("POST", `${MKT}/api/auth/mfa/verify`, { code: totpCode(secret, totpStep() - 1) }), none)).status).toBe(401);

    const rc = await mfaVerifyRoute(b2.req("POST", `${MKT}/api/auth/mfa/verify`, { recoveryCode: recoveryCodes[0].toUpperCase() }), none);
    expect(rc.status).toBe(200);
    expect((await rc.json()).recoveryCodesRemaining).toBe(9);
    expect(mail.some((m) => m.subject === "A recovery code was used to sign in")).toBe(true);

    const b3 = new Browser();
    await signIn(b3, MKT, "replay@x.example");
    expect((await mfaVerifyRoute(b3.req("POST", `${MKT}/api/auth/mfa/verify`, { recoveryCode: recoveryCodes[0] }), none)).status).toBe(401);
  });

  it("challenges expire, are limited to 5 attempts and only work on the website that issued them", async () => {
    await userWithPassword("limit@x.example", PASSWORD);
    const { secret } = await enroll(new Browser(), PORTAL, "limit@x.example");

    const b = new Browser();
    await signIn(b, PORTAL, "limit@x.example");
    for (let i = 0; i < 5; i++) {
      expect((await mfaVerifyRoute(b.req("POST", `${PORTAL}/api/auth/mfa/verify`, { code: "000000" }), none)).status).toBe(401);
    }
    const locked = await mfaVerifyRoute(b.req("POST", `${PORTAL}/api/auth/mfa/verify`, { code: totpCode(secret, totpStep()) }), none);
    expect((await locked.json()).code).toBe("mfa_challenge_expired");

    const late = new Browser();
    await signIn(late, PORTAL, "limit@x.example");
    await prisma.mfaChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await (await mfaVerifyRoute(late.req("POST", `${PORTAL}/api/auth/mfa/verify`, { code: totpCode(secret, totpStep()) }), none)).json()).code).toBe("mfa_challenge_expired");

    // A challenge from the portal cannot be completed on the marketing website.
    const cross = new Browser();
    await signIn(cross, PORTAL, "limit@x.example");
    const token = cross.jar(PORTAL).get("tx_mfa")!;
    cross.jar(MKT).set("tx_mfa", token);
    expect((await (await mfaVerifyRoute(cross.req("POST", `${MKT}/api/auth/mfa/verify`, { code: totpCode(secret, totpStep()) }), none)).json()).code).toBe("mfa_challenge_expired");
  });

  it("platform administrators must use 2FA for admin APIs and cannot turn it off", async () => {
    const { user } = await userWithPassword("ops@trustifyx.example", PASSWORD);
    await prisma.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
    const b = new Browser();
    await signIn(b, PORTAL, "ops@trustifyx.example");
    const denied = await adminOrgsRoute(b.req("GET", `${PORTAL}/api/admin/organizations`), none);
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe("mfa_required");

    await prisma.session.deleteMany({});
    const fresh = new Browser();
    const { secret } = await enroll(fresh, PORTAL, "ops@trustifyx.example");
    expect((await adminOrgsRoute(fresh.req("GET", `${PORTAL}/api/admin/organizations`), none)).status).toBe(200);

    const off = await disableRoute(fresh.req("POST", `${PORTAL}/api/account/mfa/disable`, { password: PASSWORD, code: totpCode(secret, totpStep()) }), none);
    expect(off.status).toBe(403);
    expect((await off.json()).code).toBe("mfa_enforced");
  });

  it("organization policy: owners/admins without 2FA are limited to Account Security; members are unaffected", async () => {
    const owner = await userWithPassword("owner@corp.example", PASSWORD);
    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    const adminUser = await prisma.user.create({ data: { email: "admin@corp.example", name: "Admin", passwordHash } });
    await prisma.membership.create({ data: { userId: adminUser.id, orgId: owner.org.id, role: "ADMIN" } });
    const memberUser = await prisma.user.create({ data: { email: "member@corp.example", name: "Member", passwordHash } });
    await prisma.membership.create({ data: { userId: memberUser.id, orgId: owner.org.id, role: "MEMBER" } });

    // The owner cannot enforce the policy before protecting their own account.
    const ob = new Browser();
    await signIn(ob, PORTAL, "owner@corp.example");
    const early = await orgPatchRoute(ob.req("PATCH", `${PORTAL}/api/org`, { requireMfaForPrivileged: true }), none);
    expect(early.status).toBe(400);

    const owned = new Browser();
    await enroll(owned, PORTAL, "owner@corp.example");
    expect((await orgPatchRoute(owned.req("PATCH", `${PORTAL}/api/org`, { requireMfaForPrivileged: true }), none)).status).toBe(200);

    const ab = new Browser();
    await signIn(ab, PORTAL, "admin@corp.example");
    const blocked = await websitesRoute(ab.req("GET", `${PORTAL}/api/websites`), none);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe("mfa_enrollment_required");
    expect((await mfaStatusRoute(ab.req("GET", `${PORTAL}/api/account/mfa`), none)).status).toBe(200); // can still enroll

    const mb = new Browser();
    await signIn(mb, PORTAL, "member@corp.example");
    expect((await websitesRoute(mb.req("GET", `${PORTAL}/api/websites`), none)).status).toBe(200);

    await prisma.session.deleteMany({ where: { userId: adminUser.id } });
    const ab2 = new Browser();
    await enroll(ab2, PORTAL, "admin@corp.example");
    expect((await websitesRoute(ab2.req("GET", `${PORTAL}/api/websites`), none)).status).toBe(200);
  });

  it("users may turn 2FA off with password + code, and regenerate recovery codes", async () => {
    const { user } = await userWithPassword("off@x.example", PASSWORD);
    const b = new Browser();
    const { secret, recoveryCodes } = await enroll(b, PORTAL, "off@x.example");

    const regen = await regenerateRoute(b.req("POST", `${PORTAL}/api/account/mfa/recovery-codes`, { password: PASSWORD, code: totpCode(secret, totpStep()) }), none);
    expect(regen.status).toBe(200);
    const fresh = (await regen.json()).recoveryCodes as string[];
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);

    expect((await disableRoute(b.req("POST", `${PORTAL}/api/account/mfa/disable`, { password: PASSWORD, code: "000000" }), none)).status).toBe(400);
    const off = await disableRoute(b.req("POST", `${PORTAL}/api/account/mfa/disable`, { password: PASSWORD, recoveryCode: fresh[0] }), none);
    expect(off.status).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.totpEnabledAt).toBeNull();
    expect(u.totpSecretEnc).toBeNull();
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
    expect((await (await signIn(new Browser(), PORTAL, "off@x.example")).json()).mfaRequired).toBeUndefined();
  });

  it("lost device + lost codes: email confirmation and a waiting period; cancellable; no bypass", async () => {
    const { user } = await userWithPassword("lost@x.example", PASSWORD);
    await enroll(new Browser(), PORTAL, "lost@x.example");
    await prisma.session.deleteMany({});

    // Without a password-verified challenge nothing happens.
    const anon = new Browser();
    expect((await resetRequestRoute(anon.req("POST", `${PORTAL}/api/auth/mfa/reset-request`, {}), none)).status).toBe(401);

    const b = new Browser();
    await signIn(b, PORTAL, "lost@x.example");
    expect((await resetRequestRoute(b.req("POST", `${PORTAL}/api/auth/mfa/reset-request`, {}), none)).status).toBe(200);
    const email = mail.find((m) => m.subject === "Confirm two-factor authentication reset")!;
    const token = new URL(email.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
    expect(await prisma.mfaResetRequest.count({ where: { tokenHash: token } })).toBe(0); // stored hashed

    const confirmed = await (await resetConfirmRoute(anon.req("POST", `${PORTAL}/api/auth/mfa/reset-confirm`, { token }), none)).json();
    expect(new Date(confirmed.effectiveAt).getTime()).toBeGreaterThan(Date.now() + 71 * 3600_000);

    // During the waiting period, sign-in still requires the second factor.
    expect((await (await signIn(new Browser(), PORTAL, "lost@x.example")).json()).mfaRequired).toBe(true);

    // Cancel via the emailed link, then a new request is needed.
    expect((await (await resetCancelRoute(anon.req("POST", `${PORTAL}/api/auth/mfa/reset-cancel`, { token }), none)).json()).cancelled).toBe(true);
    await prisma.mfaResetRequest.updateMany({ data: { effectiveAt: new Date(Date.now() - 1000) } });
    expect((await (await signIn(new Browser(), PORTAL, "lost@x.example")).json()).mfaRequired).toBe(true);

    // A confirmed, uncancelled request whose waiting period has passed completes at the next sign-in.
    const b2 = new Browser();
    await signIn(b2, PORTAL, "lost@x.example");
    await resetRequestRoute(b2.req("POST", `${PORTAL}/api/auth/mfa/reset-request`, {}), none);
    const email2 = mail.filter((m) => m.subject === "Confirm two-factor authentication reset").at(-1)!;
    const token2 = new URL(email2.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
    await resetConfirmRoute(anon.req("POST", `${PORTAL}/api/auth/mfa/reset-confirm`, { token: token2 }), none);
    await prisma.mfaResetRequest.updateMany({ where: { cancelledAt: null }, data: { effectiveAt: new Date(Date.now() - 1000) } });

    const done = new Browser();
    const res = await signIn(done, PORTAL, "lost@x.example");
    const body = await res.json();
    expect(body.mfaWasReset).toBe(true);
    expect(done.jar(PORTAL).get("tx_session")).toBeTruthy();
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.totpEnabledAt).toBeNull();
    const actions = (await prisma.auditLog.findMany({ where: { userId: user.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["mfa.reset_requested", "mfa.reset_confirmed", "mfa.reset_cancelled", "mfa.reset_completed"]));
  });
});

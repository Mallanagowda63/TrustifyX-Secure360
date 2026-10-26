import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { setBillingGateway } from "@/server/billing/gateway";
import { processWebhookEvent } from "@/server/billing/webhooks";
import { signForTests } from "@/server/billing/signatures";
import { verifyWebsite } from "@/server/services/websites";
import { runAvailabilityCheck, runConfigCheck } from "@/server/monitoring/run";
import { analyzeHeaders } from "@/server/monitoring/headers";
import { setMailTransport, type MailMessage } from "@/server/alerts/mailer";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { GET as plansRoute } from "@/app/api/billing/plans/route";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import { POST as verifyPaymentRoute } from "@/app/api/billing/verify/route";
import { GET as overviewRoute } from "@/app/api/billing/overview/route";
import { POST as webhookRoute } from "@/app/api/webhooks/razorpay/route";
import { POST as createWebsiteRoute } from "@/app/api/websites/route";
import { GET as getWebsiteRoute } from "@/app/api/websites/[id]/route";
import { GET as dashboardRoute } from "@/app/api/dashboard/route";
import { FakeRazorpay, signedEvent, TEST_KEY_SECRET } from "../helpers/fake-razorpay";
import { hardenedObservation } from "../helpers/fixtures";
import { hasTestDb, migrateTestDb, resetDb } from "../helpers/db";

const APP = "http://localhost:3000";
const none = { params: Promise.resolve({}) };

/** Minimal cookie-jar browser that talks to the real route handlers. */
class Browser {
  cookies = new Map<string, string>();
  request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { origin: APP };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const csrf = this.cookies.get("tx_csrf");
    if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(`${APP}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  }
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      this.cookies.set(k.trim(), v);
    }
    return res;
  }
}

describe.skipIf(!hasTestDb)("end-to-end customer journey (route handlers + worker functions)", () => {
  let rp: FakeRazorpay;
  let mail: MailMessage[];
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    rp = new FakeRazorpay();
    setBillingGateway(rp);
    mail = [];
    setMailTransport({ send: async (m) => void mail.push(m) });
  });
  afterEach(() => {
    setBillingGateway(null);
    setMailTransport(null);
  });

  it("homepage plan → signup → Razorpay checkout → verified payment → add & verify website → monitoring results on dashboard", async () => {
    // 1. Public pricing comes from the server catalog.
    const plans = await (await plansRoute(new NextRequest(`${APP}/api/billing/plans`), none)).json();
    const growth = plans.plans.find((p: { code: string }) => p.code === "GROWTH");
    expect(growth.monthly).toMatchObject({ subtotalPaise: 299_900, totalPaise: 353_882 });

    // 2. Visitor signs up.
    const b = new Browser();
    const signup = b.absorb(await signupRoute(b.request("POST", "/api/auth/signup", { name: "Asha", email: "asha@shop.example", password: "a long secure passphrase", orgName: "Asha Shop" }), none));
    expect(signup.status).toBe(201);
    expect(b.cookies.has("tx_session")).toBe(true);

    // 3. New customer has no entitlement: website creation is refused.
    expect((await createWebsiteRoute(b.request("POST", "/api/websites", { url: "shop.example.com" }), none)).status).toBe(402);

    // 4. Checkout (server decides the amount).
    const co = (await (await checkoutRoute(b.request("POST", "/api/billing/checkout", { planCode: "GROWTH", cycle: "MONTHLY" }), none)).json()).checkout;
    expect(co).toMatchObject({ mode: "RECURRING", amountPaise: 353_882, testMode: true });

    // 5. Customer pays in Razorpay; Razorpay sends a signed webhook; browser posts the handler response.
    const pay = rp.charge(co.subscriptionId);
    const ev = signedEvent("subscription.charged", { subscription: { entity: rp.subs.get(co.subscriptionId) }, payment: { entity: pay } });
    const wh = await webhookRoute(new NextRequest(`${APP}/api/webhooks/razorpay`, { method: "POST", headers: { "x-razorpay-signature": ev.signature, "x-razorpay-event-id": ev.eventId }, body: ev.raw }));
    expect(wh.status).toBe(200);
    const evRow = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { eventId: ev.eventId } });
    await processWebhookEvent(evRow.id); // what the worker does
    const verify = await verifyPaymentRoute(
      b.request("POST", "/api/billing/verify", { razorpay_payment_id: pay.id, razorpay_subscription_id: co.subscriptionId, razorpay_signature: signForTests(TEST_KEY_SECRET, `${pay.id}|${co.subscriptionId}`) }),
      none,
    );
    expect(verify.status).toBe(200);
    const overview = await (await overviewRoute(b.request("GET", "/api/billing/overview"), none)).json();
    expect(overview.entitlement).toMatchObject({ active: true, state: "ACTIVE", plan: { code: "GROWTH" } });
    expect(overview.invoices).toHaveLength(1);
    expect(mail.some((m) => /subscription is active/.test(m.subject))).toBe(true);

    // 6. Paid, website added: Pending Verification, nothing monitored yet.
    const created = await createWebsiteRoute(b.request("POST", "/api/websites", { url: "https://shop.example.com" }), none);
    expect(created.status).toBe(201);
    const site = (await created.json()).website;
    expect(site.status).toBe("PENDING_VERIFICATION");
    expect((await runAvailabilityCheck(site.id, { check: async () => { throw new Error("must not run"); } })).skipped).toBe(true);

    // 7. Ownership verification (DNS answer simulated) + authorization.
    const org = await prisma.organization.findFirstOrThrow({ where: { name: "Asha Shop" } });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "asha@shop.example" } });
    const v = await verifyWebsite({ userId: owner.id, orgId: org.id, role: "OWNER", ip: "test" }, site.id, { method: "DNS_TXT", authorizationConfirmed: true }, { dns: async () => ({ ok: true, detail: "TXT matched" }), enqueue: async () => undefined });
    expect(v.website.status).toBe("CONNECTED");

    // 8. Worker runs the existing monitoring checks and stores real results.
    await runAvailabilityCheck(site.id, { check: async () => ({ success: true, statusCode: 200, responseTimeMs: 182, redirectCount: 0, finalUrl: "https://shop.example.com/", attempts: 1, error: null }) });
    await runConfigCheck(site.id, { collect: async () => hardenedObservation({ headers: analyzeHeaders("https://shop.example.com/", 200, { "x-content-type-options": "nosniff" }) }) });

    // 9. Existing dashboard shows those results.
    const dash = await (await dashboardRoute(b.request("GET", "/api/dashboard"), none)).json();
    expect(dash.totals).toMatchObject({ connected: 1, online: 1 });
    expect(dash.severityCounts.MEDIUM + dash.severityCounts.LOW).toBeGreaterThan(0);
    const detail = await (await getWebsiteRoute(b.request("GET", `/api/websites/${site.id}`), { params: Promise.resolve({ id: site.id }) })).json();
    expect(detail.website).toMatchObject({ status: "CONNECTED", state: "UP", lastResponseTimeMs: 182 });

    // 10. A different customer cannot see this website.
    const other = new Browser();
    other.absorb(await signupRoute(other.request("POST", "/api/auth/signup", { name: "Eve", email: "eve@other.example", password: "another long passphrase", orgName: "Eve Co" }), none));
    expect((await getWebsiteRoute(other.request("GET", `/api/websites/${site.id}`), { params: Promise.resolve({ id: site.id }) })).status).toBe(404);
  });
});

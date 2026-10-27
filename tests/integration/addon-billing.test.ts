import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { setBillingGateway } from "@/server/billing/gateway";
import { addonEntitlement, getEntitlement } from "@/server/billing/entitlements";
import { billingOverview, cancelAddon, startAddonCheckout, startCheckout, verifyCheckout } from "@/server/billing/service";
import { signForTests } from "@/server/billing/signatures";
import { setMailTransport } from "@/server/alerts/mailer";
import { FakeRazorpay, TEST_KEY_SECRET } from "../helpers/fake-razorpay";
import { hasTestDb, makeOrg, migrateTestDb, resetDb } from "../helpers/db";

// Razorpay responses come from the in-memory FakeRazorpay test double, not a live account.
let rp: FakeRazorpay;
const checkoutResponse = (subId: string, paymentId: string) => ({
  razorpay_payment_id: paymentId,
  razorpay_subscription_id: subId,
  razorpay_signature: signForTests(TEST_KEY_SECRET, `${paymentId}|${subId}`),
});

describe.skipIf(!hasTestDb)("Secure360 Protect add-on billing", () => {
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    rp = new FakeRazorpay();
    setBillingGateway(rp);
    setMailTransport({ send: async () => undefined });
  });
  afterEach(() => {
    setBillingGateway(null);
    setMailTransport(null);
  });

  async function paidBase() {
    const o = await makeOrg("Shop", "OWNER", { plan: null });
    const co = await startCheckout(o.actor, { planCode: "GROWTH", cycle: "MONTHLY" });
    await verifyCheckout(o.actor, checkoutResponse(co.subscriptionId!, rp.charge(co.subscriptionId!).id));
    return o;
  }

  it("requires an active base plan; activates only after Razorpay confirms; never touches the base plan", async () => {
    const unpaid = await makeOrg("Unpaid", "OWNER", { plan: null });
    await expect(startAddonCheckout(unpaid.actor, { addonCode: "PROTECT", cycle: "MONTHLY" })).rejects.toMatchObject({ code: "subscription_required" });

    const o = await paidBase();
    await expect(startAddonCheckout(o.actor, { addonCode: "GROWTH", cycle: "MONTHLY" })).rejects.toMatchObject({ code: "invalid_plan" });
    const co = await startAddonCheckout(o.actor, { addonCode: "PROTECT", cycle: "MONTHLY" });
    expect(co.amountPaise).toBe(589_882); // ₹4,999 + 18% GST, computed on the server
    expect((await addonEntitlement(o.org.id, "PROTECT")).active).toBe(false); // nothing before payment

    // A forged browser response does not activate it.
    await expect(verifyCheckout(o.actor, { razorpay_payment_id: "pay_forged", razorpay_subscription_id: co.subscriptionId!, razorpay_signature: "0".repeat(64) })).rejects.toMatchObject({ code: "invalid_signature" });
    expect((await addonEntitlement(o.org.id, "PROTECT")).active).toBe(false);

    await verifyCheckout(o.actor, checkoutResponse(co.subscriptionId!, rp.charge(co.subscriptionId!).id));
    expect((await addonEntitlement(o.org.id, "PROTECT")).active).toBe(true);
    const base = await getEntitlement(o.org.id);
    expect(base).toMatchObject({ active: true, state: "ACTIVE" });
    expect(base.plan?.code).toBe("GROWTH");
    expect(await prisma.subscription.count({ where: { orgId: o.org.id, status: "ACTIVE" } })).toBe(2);

    const ov = await billingOverview(o.org.id);
    expect(ov.entitlement.plan?.code).toBe("GROWTH");
    expect(ov.plans.map((p) => p.code)).toEqual(["STARTER", "GROWTH", "BUSINESS"]);
    expect(ov.addons.find((a) => a.code === "PROTECT")).toMatchObject({ active: true });

    await expect(startAddonCheckout(o.actor, { addonCode: "PROTECT", cycle: "MONTHLY" })).rejects.toMatchObject({ code: "already_subscribed" });
  });

  it("cancelling the add-on leaves the base plan running", async () => {
    const o = await paidBase();
    const co = await startAddonCheckout(o.actor, { addonCode: "PROTECT", cycle: "MONTHLY" });
    await verifyCheckout(o.actor, checkoutResponse(co.subscriptionId!, rp.charge(co.subscriptionId!).id));

    await cancelAddon(o.actor, { addonCode: "PROTECT", atPeriodEnd: false });
    expect((await addonEntitlement(o.org.id, "PROTECT")).active).toBe(false);
    expect(await getEntitlement(o.org.id)).toMatchObject({ active: true, state: "ACTIVE" });
    await expect(cancelAddon(o.actor, { addonCode: "PROTECT", atPeriodEnd: true })).rejects.toMatchObject({ code: "not_active" });
  });

  it("the add-on stops granting access when the base plan ends", async () => {
    const o = await paidBase();
    const co = await startAddonCheckout(o.actor, { addonCode: "PROTECT", cycle: "MONTHLY" });
    await verifyCheckout(o.actor, checkoutResponse(co.subscriptionId!, rp.charge(co.subscriptionId!).id));
    const baseSub = await prisma.subscription.findFirstOrThrow({ where: { orgId: o.org.id, plan: { code: "GROWTH" } } });
    await prisma.subscription.update({ where: { id: baseSub.id }, data: { status: "CANCELLED", currentPeriodEnd: new Date(Date.now() - 1000), endedAt: new Date(Date.now() - 1000) } });
    expect(await addonEntitlement(o.org.id, "PROTECT")).toMatchObject({ active: false, baseActive: false });
  });
});

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyOrderPaymentSignature,
  verifySubscriptionPaymentSignature,
  verifyWebhookSignature,
} from "@/server/billing/signatures";
import { DEFAULT_PLANS, formatInr, priceFor } from "@/server/billing/plans";
import { addCycle } from "@/server/billing/sync";
import { accessUntil } from "@/server/billing/entitlements";
import type { Subscription } from "@prisma/client";

const hmac = (secret: string, msg: string | Buffer) => createHmac("sha256", secret).update(msg).digest("hex");

describe("Razorpay signature verification", () => {
  const secret = "key_secret";

  it("accepts a correct subscription checkout signature (payment_id|subscription_id)", () => {
    const sig = hmac(secret, "pay_123|sub_456");
    expect(verifySubscriptionPaymentSignature({ paymentId: "pay_123", subscriptionId: "sub_456", signature: sig, keySecret: secret })).toBe(true);
  });

  it("rejects swapped field order, wrong ids, wrong secret, and malformed signatures", () => {
    const sig = hmac(secret, "pay_123|sub_456");
    expect(verifySubscriptionPaymentSignature({ paymentId: "sub_456", subscriptionId: "pay_123", signature: sig, keySecret: secret })).toBe(false);
    expect(verifySubscriptionPaymentSignature({ paymentId: "pay_123", subscriptionId: "sub_999", signature: sig, keySecret: secret })).toBe(false);
    expect(verifySubscriptionPaymentSignature({ paymentId: "pay_123", subscriptionId: "sub_456", signature: sig, keySecret: "other" })).toBe(false);
    for (const bad of ["", "abc", "z".repeat(64), sig.slice(0, 63)]) {
      expect(verifySubscriptionPaymentSignature({ paymentId: "pay_123", subscriptionId: "sub_456", signature: bad, keySecret: secret })).toBe(false);
    }
  });

  it("uses order_id|payment_id for one-time orders", () => {
    const sig = hmac(secret, "order_1|pay_2");
    expect(verifyOrderPaymentSignature({ orderId: "order_1", paymentId: "pay_2", signature: sig, keySecret: secret })).toBe(true);
    expect(verifyOrderPaymentSignature({ orderId: "pay_2", paymentId: "order_1", signature: sig, keySecret: secret })).toBe(false);
  });

  it("verifies webhooks over the exact raw bytes", () => {
    const raw = Buffer.from('{"event":"subscription.charged","payload":{"a":1}}');
    const sig = hmac("whsec", raw);
    expect(verifyWebhookSignature(raw, sig, "whsec")).toBe(true);
    // Re-serialised JSON (different whitespace) must NOT verify: never sign a parsed copy.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 1));
    expect(verifyWebhookSignature(reserialised, sig, "whsec")).toBe(false);
    expect(verifyWebhookSignature(raw, null, "whsec")).toBe(false);
    expect(verifyWebhookSignature(raw, sig.toUpperCase(), "whsec")).toBe(true);
  });
});

describe("server-side pricing", () => {
  const starter = { monthlyPricePaise: 99_900, annualPricePaise: 999_000, currency: "INR" };

  it("adds 18% GST on top of list prices (tax-exclusive mode)", () => {
    expect(priceFor(starter, "MONTHLY")).toMatchObject({ subtotalPaise: 99_900, taxPaise: 17_982, totalPaise: 117_882, taxRateBp: 1800 });
    expect(priceFor(starter, "ANNUAL")).toMatchObject({ subtotalPaise: 999_000, totalPaise: 1_178_820 });
  });

  it("refuses an annual price that is not configured", () => {
    expect(() => priceFor({ ...starter, annualPricePaise: null }, "ANNUAL")).toThrow();
  });

  it("ships the published catalog: Starter ₹999, Growth ₹2,999, Business ₹7,999 with 1/5/20 websites", () => {
    expect(DEFAULT_PLANS.filter((p) => p.kind === "BASE").map((p) => [p.code, p.monthlyPricePaise, p.maxWebsites])).toEqual([
      ["STARTER", 99_900, 1],
      ["GROWTH", 299_900, 5],
      ["BUSINESS", 799_900, 20],
    ]);
    // Optional add-on (proposed price), never a base plan.
    expect(DEFAULT_PLANS.filter((p) => p.kind === "ADDON").map((p) => [p.code, p.monthlyPricePaise])).toEqual([["PROTECT", 499_900]]);
    expect(formatInr(299_900)).toBe("₹2,999");
    expect(formatInr(117_882)).toBe("₹1,178.82");
  });

  it("never advertises unsupported services", () => {
    const text = DEFAULT_PLANS.flatMap((p) => p.features).join(" ").toLowerCase();
    expect(text).not.toMatch(/24\s*\/\s*7|soc|remediation service|guarantee|malware removal/);
  });
});

describe("billing periods and access", () => {
  it("adds calendar months safely at month ends", () => {
    expect(addCycle(new Date("2026-01-31T10:00:00Z"), "MONTHLY").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addCycle(new Date("2026-03-15T00:00:00Z"), "MONTHLY").toISOString()).toBe("2026-04-15T00:00:00.000Z");
    expect(addCycle(new Date("2028-02-29T00:00:00Z"), "ANNUAL").toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });

  const base = {
    status: "ACTIVE",
    mode: "RECURRING",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date("2026-11-01T00:00:00Z"),
    graceUntil: null,
    endedAt: null,
  } as unknown as Subscription;

  it("recurring access tolerates late renewal webhooks for the grace window", () => {
    expect(accessUntil(base, 7)?.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(accessUntil({ ...base, cancelAtPeriodEnd: true }, 7)?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("past-due uses the grace deadline; pending payment and expired grant nothing", () => {
    expect(accessUntil({ ...base, status: "PAST_DUE", graceUntil: new Date("2026-11-05T00:00:00Z") }, 7)?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(accessUntil({ ...base, status: "PENDING_PAYMENT" }, 7)).toBeNull();
    expect(accessUntil({ ...base, status: "EXPIRED" }, 7)).toBeNull();
    expect(accessUntil({ ...base, status: "ABANDONED" }, 7)).toBeNull();
  });

  it("immediate cancellation ends access at endedAt", () => {
    const ended = new Date("2026-10-20T00:00:00Z");
    expect(accessUntil({ ...base, status: "CANCELLED", endedAt: ended }, 7)?.toISOString()).toBe(ended.toISOString());
  });
});

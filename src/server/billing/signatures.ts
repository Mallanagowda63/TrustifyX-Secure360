import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay signature checks (constant-time HMAC-SHA256, hex):
 *  - Subscription checkout: HMAC(key_secret, payment_id + "|" + subscription_id)
 *  - Order checkout:        HMAC(key_secret, order_id + "|" + payment_id)
 *  - Webhooks:              HMAC(webhook_secret, raw request body bytes)
 * The ids used are always the ones the SERVER stored, never ids echoed back by the browser.
 */

function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqualHex(expected: string, received: string | null | undefined): boolean {
  if (!received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifySubscriptionPaymentSignature(params: {
  paymentId: string;
  subscriptionId: string;
  signature: string;
  keySecret: string;
}): boolean {
  return safeEqualHex(hmacHex(params.keySecret, `${params.paymentId}|${params.subscriptionId}`), params.signature);
}

export function verifyOrderPaymentSignature(params: { orderId: string; paymentId: string; signature: string; keySecret: string }): boolean {
  return safeEqualHex(hmacHex(params.keySecret, `${params.orderId}|${params.paymentId}`), params.signature);
}

export function verifyWebhookSignature(rawBody: Buffer | string, signature: string | null, webhookSecret: string): boolean {
  return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
}

/** Test/support helper: produce the signature Razorpay would send for a body. */
export function signWebhookBody(rawBody: Buffer | string, webhookSecret: string): string {
  return hmacHex(webhookSecret, rawBody);
}

export function signForTests(secret: string, message: string): string {
  return hmacHex(secret, message);
}

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { billingAudit } from "./audit";
import { billingGateway, providerErrorMessage, type ProviderPayment, type ProviderSubscription } from "./gateway";
import { verifyWebhookSignature } from "./signatures";
import {
  applyPrepaidPayment,
  applyProviderSubscription,
  handleRefund,
  issueInvoice,
  recordProviderPayment,
} from "./sync";

export type WebhookReceipt =
  | { ok: true; duplicate: boolean; eventId: string; id: string }
  | { ok: false; status: number; error: string };

interface RazorpayEvent {
  event: string;
  payload: {
    subscription?: { entity: ProviderSubscription };
    payment?: { entity: ProviderPayment };
    refund?: { entity: { id: string; payment_id: string; amount: number } };
    order?: { entity: { id: string } };
  };
  created_at?: number;
}

/**
 * Step 1 (request path, must answer within seconds): verify the signature over the RAW body,
 * then durably store the event. Forged/unsigned requests are rejected and only noted in the
 * billing audit log; they never touch the event table, so they cannot pre-claim a real event id.
 */
export async function receiveWebhook(rawBody: Buffer, signature: string | null, eventIdHeader: string | null, ip: string): Promise<WebhookReceipt> {
  const secret = env().RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return { ok: false, status: 503, error: "Webhook secret not configured" };
  if (!verifyWebhookSignature(rawBody, signature, secret)) {
    await billingAudit({ actorType: "WEBHOOK", action: "webhook.signature_invalid", details: { ip, bytes: rawBody.length, eventId: eventIdHeader?.slice(0, 80) ?? null } });
    return { ok: false, status: 400, error: "Invalid signature" };
  }
  let event: RazorpayEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, status: 400, error: "Malformed payload" };
  }
  if (!event?.event || typeof event.event !== "string") return { ok: false, status: 400, error: "Malformed payload" };
  const eventId = (eventIdHeader?.trim() || `sha256:${createHash("sha256").update(rawBody).digest("hex")}`).slice(0, 200);
  try {
    const row = await prisma.paymentWebhookEvent.create({
      data: { eventId, eventType: event.event.slice(0, 100), payload: event as unknown as Prisma.InputJsonValue },
    });
    return { ok: true, duplicate: false, eventId, id: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { eventId } });
      return { ok: true, duplicate: true, eventId, id: existing.id };
    }
    throw err;
  }
}

/** Step 2 (worker): process one stored event. Safe to call repeatedly. */
export async function processWebhookEvent(id: string) {
  const row = await prisma.paymentWebhookEvent.findUnique({ where: { id } });
  if (!row || row.status === "PROCESSED" || row.status === "IGNORED") return row?.status ?? "MISSING";
  await prisma.paymentWebhookEvent.update({ where: { id }, data: { attempts: { increment: 1 } } });
  try {
    const outcome = await dispatch(row.payload as unknown as RazorpayEvent);
    await prisma.paymentWebhookEvent.update({ where: { id }, data: { status: outcome, processedAt: new Date(), error: null } });
    return outcome;
  } catch (err) {
    const message = providerErrorMessage(err);
    await prisma.paymentWebhookEvent.update({ where: { id }, data: { status: "FAILED", error: message } });
    await billingAudit({ actorType: "WEBHOOK", action: "webhook.processing_failed", details: { eventId: row.eventId, type: row.eventType, error: message } });
    throw err;
  }
}

async function dispatch(event: RazorpayEvent): Promise<"PROCESSED" | "IGNORED"> {
  const type = event.event;

  if (type.startsWith("subscription.")) {
    const entity = event.payload.subscription?.entity;
    if (!entity?.id) return "IGNORED";
    const local = await prisma.subscription.findUnique({ where: { razorpaySubscriptionId: entity.id }, include: { plan: true } });
    if (!local) return "IGNORED"; // not created by this platform
    const payment = event.payload.payment?.entity;
    if (payment?.id) {
      const recorded = await recordProviderPayment(payment, { orgId: local.orgId, subscriptionId: local.id }, "WEBHOOK");
      if (recorded.newlyCaptured || recorded.status === "CAPTURED") {
        await issueInvoice(recorded.paymentId, { start: entity.current_start ? new Date(entity.current_start * 1000) : null, end: entity.current_end ? new Date(entity.current_end * 1000) : null });
      }
    }
    // Apply the provider's latest state, not the (possibly stale or out-of-order) event snapshot.
    let latest: ProviderSubscription = entity;
    try {
      latest = await billingGateway().fetchSubscription(entity.id);
    } catch (err) {
      if ((entity.paid_count ?? 0) < local.paidCount) throw err; // stale snapshot and provider unreachable: retry later
    }
    await applyProviderSubscription(local, latest, "WEBHOOK");
    return "PROCESSED";
  }

  if (type === "payment.captured" || type === "payment.authorized" || type === "payment.failed" || type === "order.paid") {
    const payment = event.payload.payment?.entity;
    if (!payment?.id) return "IGNORED";
    const orderId = payment.order_id ?? event.payload.order?.entity.id ?? null;
    const local = orderId
      ? await prisma.subscription.findFirst({ where: { razorpayOrderId: orderId }, include: { plan: true } })
      : null;
    if (!local) {
      // Recurring charges are handled via subscription.* events; update a payment we already know.
      const known = await prisma.payment.findUnique({ where: { razorpayPaymentId: payment.id } });
      if (!known) return "IGNORED";
      await recordProviderPayment(payment, { orgId: known.orgId, subscriptionId: known.subscriptionId }, "WEBHOOK");
      return "PROCESSED";
    }
    let p = payment;
    if (p.status === "authorized" && local.mode === "PREPAID") {
      p = await billingGateway().capturePayment(p.id, p.amount, p.currency);
    }
    const recorded = await recordProviderPayment(p, { orgId: local.orgId, subscriptionId: local.id }, "WEBHOOK");
    if (local.mode === "PREPAID") await applyPrepaidPayment(local, recorded, "WEBHOOK");
    return "PROCESSED";
  }

  if (type.startsWith("refund.") || type === "payment.refunded") {
    const paymentId = event.payload.refund?.entity.payment_id ?? event.payload.payment?.entity.id;
    if (!paymentId) return "IGNORED";
    const known = await prisma.payment.findUnique({ where: { razorpayPaymentId: paymentId } });
    if (!known) return "IGNORED";
    const fresh = await billingGateway().fetchPayment(paymentId);
    const recorded = await recordProviderPayment(fresh, { orgId: known.orgId, subscriptionId: known.subscriptionId }, "WEBHOOK");
    if (recorded.status === "REFUNDED") await handleRefund(recorded.paymentId, "WEBHOOK");
    return "PROCESSED";
  }

  return "IGNORED";
}

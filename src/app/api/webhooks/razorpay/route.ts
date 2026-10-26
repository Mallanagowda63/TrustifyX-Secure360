import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/server/api";
import { receiveWebhook, processWebhookEvent } from "@/server/billing/webhooks";
import { enqueueWebhookProcessing } from "@/server/queue";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024;

/**
 * Razorpay webhook endpoint. Server-to-server (no cookies), so it bypasses CSRF; authenticity
 * comes from the HMAC signature over the exact raw bytes. The event is stored and acknowledged
 * quickly; processing happens in the worker (falls back to inline if the queue is down).
 */
export async function POST(req: NextRequest) {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 });

  const result = await receiveWebhook(raw, req.headers.get("x-razorpay-signature"), req.headers.get("x-razorpay-event-id"), clientIp(req));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.duplicate) {
    try {
      await enqueueWebhookProcessing(result.id);
    } catch {
      await processWebhookEvent(result.id).catch(() => undefined); // retried by reconciliation
    }
  }
  return NextResponse.json({ ok: true, duplicate: result.duplicate });
}

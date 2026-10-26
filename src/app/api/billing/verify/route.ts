import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { verifyCheckout } from "@/server/billing/service";

const id = z.string().trim().min(5).max(64).regex(/^[A-Za-z0-9_]+$/);
const body = z
  .object({
    razorpay_payment_id: id,
    razorpay_signature: z.string().trim().regex(/^[a-f0-9]{64}$/i),
    razorpay_subscription_id: id.optional(),
    razorpay_order_id: id.optional(),
  })
  .strict();

export const POST = authedRoute("billing.manage", async ({ req, ctx }) => verifyCheckout(actorOf(ctx), await readJson(req, body)));

import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

export type BillingActor = "USER" | "ADMIN" | "WEBHOOK" | "SYSTEM";

/** Append-only billing trail (separate from the org audit log so it survives org-level filtering). */
export async function billingAudit(entry: {
  orgId?: string | null;
  actorType: BillingActor;
  actorUserId?: string | null;
  action: string;
  subscriptionId?: string | null;
  paymentId?: string | null;
  details?: Prisma.InputJsonValue;
}) {
  try {
    await prisma.billingAuditLog.create({
      data: {
        orgId: entry.orgId ?? null,
        actorType: entry.actorType,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        subscriptionId: entry.subscriptionId ?? null,
        paymentId: entry.paymentId ?? null,
        details: entry.details,
      },
    });
  } catch (err) {
    console.error("[billing-audit] failed", entry.action, (err as Error).message);
  }
}

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { ApiError } from "../api";
import { billingAudit } from "./audit";
import { reconcileOrgMonitoring } from "./monitoring-gate";
import { reconcileBilling } from "./reconcile";
import { processWebhookEvent } from "./webhooks";
import { listPlans } from "./plans";

/**
 * Platform-operator billing tools. There is deliberately no way to mark a payment or
 * subscription as paid: paid state only comes from Razorpay. Operators can (a) edit catalog
 * prices for FUTURE checkouts, (b) grant clearly-labelled complimentary access with a reason,
 * (c) trigger reconciliation / webhook reprocessing. Every action is billing-audited.
 */

export async function adminBillingOverview() {
  const now = new Date();
  const [subscriptions, failedPayments, recentPayments, webhookFailures, awaitingVerification, auditLog, plans, counts] = await Promise.all([
    prisma.subscription.findMany({
      where: { status: { not: "ABANDONED" } },
      include: { plan: { select: { code: true, name: true } }, org: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
    prisma.payment.findMany({ where: { status: "FAILED" }, include: { org: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.payment.findMany({ include: { org: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.paymentWebhookEvent.findMany({ where: { status: { in: ["FAILED", "RECEIVED"] } }, orderBy: { receivedAt: "desc" }, take: 50, select: { id: true, eventId: true, eventType: true, status: true, attempts: true, error: true, receivedAt: true } }),
    prisma.organization.findMany({
      where: {
        subscriptions: { some: { status: { in: ["ACTIVE", "PAST_DUE"] } } },
        NOT: { websites: { some: { verifiedAt: { not: null } } } },
      },
      select: { id: true, name: true, createdAt: true, _count: { select: { websites: true } } },
      take: 100,
    }),
    prisma.billingAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    listPlans(true),
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const organizations = await prisma.organization.findMany({ select: { id: true, name: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 500 });
  const orgIds = [...new Set(subscriptions.map((s) => s.orgId))];
  const usage = await prisma.website.groupBy({ by: ["orgId", "status"], where: { orgId: { in: orgIds } }, _count: { _all: true } });
  return {
    generatedAt: now,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      org: s.org,
      plan: s.plan,
      cycle: s.cycle,
      mode: s.mode,
      status: s.status,
      amountPaise: s.amountPaise,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      grantReason: s.grantReason,
      razorpaySubscriptionId: s.razorpaySubscriptionId,
      websites: usage.filter((u) => u.orgId === s.orgId).reduce((a, u) => a + u._count._all, 0),
      monitored: usage.filter((u) => u.orgId === s.orgId && u.status === "CONNECTED").reduce((a, u) => a + u._count._all, 0),
    })),
    failedPayments,
    recentPayments,
    webhookFailures,
    awaitingVerification,
    auditLog,
    plans,
    organizations,
  };
}

export const planEditSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    tagline: z.string().trim().max(120),
    description: z.string().trim().max(500),
    monthlyPricePaise: z.number().int().min(100).max(10_000_000),
    annualPricePaise: z.number().int().min(100).max(120_000_000).nullable(),
    maxWebsites: z.number().int().min(1).max(1000),
    maxMembers: z.number().int().min(1).max(1000),
    features: z.array(z.string().trim().min(1).max(160)).max(20),
    highlight: z.boolean(),
    active: z.boolean(),
    aiAssistant: z.boolean(),
    scheduledReports: z.boolean(),
    auditLogs: z.boolean(),
  })
  .partial()
  .strict();

/** Catalog edits apply to new checkouts only; existing subscriptions keep the amount they agreed to. */
export async function adminUpdatePlan(adminUserId: string, code: string, patch: z.infer<typeof planEditSchema>, confirmCode: string) {
  if (confirmCode !== code) throw new ApiError(400, "Type the plan code to confirm this change");
  const before = await prisma.pricingPlan.findUnique({ where: { code } });
  if (!before) throw new ApiError(404, "Plan not found");
  const updated = await prisma.pricingPlan.update({ where: { code }, data: { ...patch, ...(patch.features ? { features: patch.features } : {}) } });
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(patch)) {
    const prev = (before as Record<string, unknown>)[k];
    if (JSON.stringify(prev) !== JSON.stringify(v)) diff[k] = { from: prev, to: v };
  }
  await billingAudit({ actorType: "ADMIN", actorUserId: adminUserId, action: "plan.updated", details: { code, diff } as Prisma.InputJsonValue });
  return updated;
}

export async function adminGrantComplimentary(adminUserId: string, input: { orgId: string; planCode: string; days: number; reason: string }) {
  const org = await prisma.organization.findUnique({ where: { id: input.orgId } });
  if (!org) throw new ApiError(404, "Organization not found");
  const plan = await prisma.pricingPlan.findUnique({ where: { code: input.planCode } });
  if (!plan) throw new ApiError(404, "Plan not found");
  if (!input.reason.trim()) throw new ApiError(400, "A reason is required");
  const now = new Date();
  const sub = await prisma.subscription.create({
    data: {
      orgId: org.id,
      planId: plan.id,
      cycle: "MONTHLY",
      mode: "COMPLIMENTARY",
      status: "ACTIVE",
      amountPaise: 0,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + input.days * 86_400_000),
      grantReason: input.reason.trim().slice(0, 300),
      createdById: adminUserId,
    },
  });
  await billingAudit({ orgId: org.id, actorType: "ADMIN", actorUserId: adminUserId, action: "complimentary.granted", subscriptionId: sub.id, details: { plan: plan.code, days: input.days, reason: input.reason } });
  await reconcileOrgMonitoring(org.id);
  return sub;
}

export async function adminRevokeComplimentary(adminUserId: string, subscriptionId: string) {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.mode !== "COMPLIMENTARY") throw new ApiError(404, "Complimentary grant not found");
  const now = new Date();
  await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", cancelledAt: now, endedAt: now, currentPeriodEnd: now } });
  await billingAudit({ orgId: sub.orgId, actorType: "ADMIN", actorUserId: adminUserId, action: "complimentary.revoked", subscriptionId: sub.id });
  await reconcileOrgMonitoring(sub.orgId);
}

export async function adminReconcile(adminUserId: string) {
  const stats = await reconcileBilling();
  await billingAudit({ actorType: "ADMIN", actorUserId: adminUserId, action: "reconcile.triggered", details: stats as unknown as Prisma.InputJsonValue });
  return stats;
}

export async function adminReprocessWebhook(adminUserId: string, id: string) {
  const outcome = await processWebhookEvent(id).catch((err: Error) => `FAILED: ${err.message}`);
  await billingAudit({ actorType: "ADMIN", actorUserId: adminUserId, action: "webhook.reprocessed", details: { id, outcome } });
  return { outcome };
}

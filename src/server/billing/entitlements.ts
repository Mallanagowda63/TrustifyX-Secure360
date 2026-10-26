import type { PricingPlan, Subscription } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { ApiError } from "../api";
import { planRank } from "./plans";

export type EntitlementState = "NONE" | "ACTIVE" | "GRACE" | "CANCELLING" | "COMPLIMENTARY";

export interface Entitlement {
  active: boolean;
  state: EntitlementState;
  subscription: (Subscription & { plan: PricingPlan }) | null;
  plan: PricingPlan | null;
  /** Service continues until this moment unless renewed. */
  accessUntil: Date | null;
  limits: {
    websites: number;
    members: number;
    availabilityIntervalSec: number;
    aiAssistant: boolean;
    scheduledReports: boolean;
    auditLogs: boolean;
  };
}

const NO_LIMITS: Entitlement["limits"] = {
  websites: 0,
  members: 1,
  availabilityIntervalSec: 300,
  aiAssistant: false,
  scheduledReports: false,
  auditLogs: false,
};

const DAY = 86_400_000;

/**
 * When a subscription stops granting service. Rows only reach these states from verified
 * provider data (API fetch / signed webhook) or an explicit complimentary grant.
 */
export function accessUntil(sub: Subscription, graceDays = env().BILLING_GRACE_DAYS): Date | null {
  const end = sub.currentPeriodEnd;
  switch (sub.status) {
    case "ACTIVE":
      if (!end) return null;
      // Recurring renewals are charged at period end; tolerate late webhooks for the grace window.
      return sub.mode === "RECURRING" && !sub.cancelAtPeriodEnd ? new Date(end.getTime() + graceDays * DAY) : end;
    case "PAST_DUE":
    case "HALTED":
      return sub.graceUntil ?? end;
    case "CANCELLED":
    case "COMPLETED": {
      if (!end) return null;
      return sub.endedAt && sub.endedAt < end ? sub.endedAt : end;
    }
    default:
      return null;
  }
}

export async function getEntitlement(orgId: string, now = new Date()): Promise<Entitlement> {
  const subs = await prisma.subscription.findMany({
    where: { orgId, status: { in: ["ACTIVE", "PAST_DUE", "HALTED", "CANCELLED", "COMPLETED"] } },
    include: { plan: true },
    orderBy: { currentPeriodEnd: "desc" },
    take: 20,
  });
  let best: { sub: Subscription & { plan: PricingPlan }; until: Date } | null = null;
  for (const sub of subs) {
    if (sub.currentPeriodStart && sub.currentPeriodStart > now) continue; // scheduled for later
    const until = accessUntil(sub);
    if (!until || until <= now) continue;
    if (!best || planRank(sub.plan) > planRank(best.sub.plan) || (planRank(sub.plan) === planRank(best.sub.plan) && until > best.until)) {
      best = { sub, until };
    }
  }
  if (!best) return { active: false, state: "NONE", subscription: null, plan: null, accessUntil: null, limits: NO_LIMITS };

  const s = best.sub;
  const inGrace = s.status === "PAST_DUE" || s.status === "HALTED" || (s.currentPeriodEnd !== null && s.currentPeriodEnd <= now);
  const state: EntitlementState =
    s.mode === "COMPLIMENTARY"
      ? "COMPLIMENTARY"
      : inGrace
        ? "GRACE"
        : s.cancelAtPeriodEnd || s.status === "CANCELLED" || s.status === "COMPLETED"
          ? "CANCELLING"
          : "ACTIVE";
  return {
    active: true,
    state,
    subscription: s,
    plan: s.plan,
    accessUntil: best.until,
    limits: {
      websites: s.plan.maxWebsites,
      members: s.plan.maxMembers,
      availabilityIntervalSec: s.plan.availabilityIntervalSec,
      aiAssistant: s.plan.aiAssistant,
      scheduledReports: s.plan.scheduledReports,
      auditLogs: s.plan.auditLogs,
    },
  };
}

/** 402-style error used by services when an action needs an active subscription. */
export async function requireEntitlement(orgId: string): Promise<Entitlement> {
  const ent = await getEntitlement(orgId);
  if (!ent.active) {
    throw new ApiError(402, "An active subscription is required. Choose a plan under Billing to continue.", "subscription_required");
  }
  return ent;
}

export type Feature = "aiAssistant" | "scheduledReports" | "auditLogs";
const FEATURE_LABEL: Record<Feature, string> = {
  aiAssistant: "AI security explanations",
  scheduledReports: "Scheduled email reports",
  auditLogs: "Organization audit logs",
};

export async function requireFeature(orgId: string, feature: Feature): Promise<Entitlement> {
  const ent = await requireEntitlement(orgId);
  if (!ent.limits[feature]) {
    throw new ApiError(403, `${FEATURE_LABEL[feature]} are not included in your ${ent.plan?.name ?? "current"} plan. Upgrade under Billing.`, "plan_feature");
  }
  return ent;
}

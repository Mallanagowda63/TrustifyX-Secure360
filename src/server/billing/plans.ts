import type { BillingCycle, PricingPlan } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";

/**
 * Initial catalog. Seeded into the PricingPlan table only when a plan code does not exist yet,
 * so later edits made through the admin console are never overwritten. All checkout amounts
 * are read from the database on the server; the browser never supplies a price.
 */
export const DEFAULT_PLANS = [
  {
    code: "STARTER",
    kind: "BASE",
    name: "Starter",
    tagline: "For individuals and small websites",
    description: "Essential external security monitoring for one website.",
    monthlyPricePaise: 99_900,
    maxWebsites: 1,
    maxMembers: 1,
    aiAssistant: false,
    scheduledReports: false,
    auditLogs: false,
    highlight: false,
    sortOrder: 1,
    features: [
      "1 verified website",
      "Uptime checks every 5 minutes",
      "SSL/TLS certificate monitoring",
      "Security-header checks",
      "DNS monitoring",
      "Security findings dashboard",
      "Email alerts (when SMTP is configured)",
      "Downloadable security reports",
    ],
  },
  {
    code: "GROWTH",
    kind: "BASE",
    name: "Growth",
    tagline: "For growing businesses",
    description: "Monitoring for several websites with AI explanations and team access.",
    monthlyPricePaise: 299_900,
    maxWebsites: 5,
    maxMembers: 5,
    aiAssistant: true,
    scheduledReports: true,
    auditLogs: false,
    highlight: true,
    sortOrder: 2,
    features: [
      "Up to 5 verified websites",
      "Everything in Starter",
      "AI-assisted security explanations (when the AI provider is configured)",
      "Priority-based findings",
      "Weekly and monthly emailed reports",
      "Team access (up to 5 members)",
      "Centralized monitoring dashboard",
    ],
  },
  {
    code: "BUSINESS",
    kind: "BASE",
    name: "Business",
    tagline: "For agencies and growing companies",
    description: "Multi-website monitoring with team permissions and organization audit logs.",
    monthlyPricePaise: 799_900,
    maxWebsites: 20,
    maxMembers: 25,
    aiAssistant: true,
    scheduledReports: true,
    auditLogs: true,
    highlight: false,
    sortOrder: 3,
    features: [
      "Up to 20 verified websites",
      "Everything in Growth",
      "Multiple team members with role permissions (up to 25)",
      "Organization audit logs",
      "Centralized multi-website reporting",
      "Advanced findings management",
      "Business-hours email support (per published support policy)",
    ],
  },
  {
    // Add-on on top of an active base plan. The price is a business proposal, editable in the admin console.
    code: "PROTECT",
    kind: "ADDON",
    name: "Secure360 Protect",
    tagline: "Website protection add-on",
    description: "TrustifyX-managed Cloudflare protection settings, firewall rules and security-event dashboards for your verified websites.",
    monthlyPricePaise: 499_900,
    maxWebsites: 0,
    maxMembers: 0,
    aiAssistant: false,
    scheduledReports: false,
    auditLogs: false,
    highlight: false,
    sortOrder: 10,
    features: [
      "Connect your own Cloudflare account (Cloudflare charges, if any, are billed by Cloudflare)",
      "Review-then-apply protection settings and TrustifyX-managed firewall rules",
      "Real Cloudflare security events and trends",
      "Change history for every protection change",
      "Requires an active Starter, Growth or Business plan",
    ],
  },
] as const;

export const ADDON_PROTECT = "PROTECT";

export async function seedPlans() {
  for (const p of DEFAULT_PLANS) {
    await prisma.pricingPlan.upsert({
      where: { code: p.code },
      update: {},
      create: { ...p, features: [...p.features], annualPricePaise: p.monthlyPricePaise * 10 },
    });
  }
}

let seeded: Promise<void> | null = null;
/** Ensures default plans exist (idempotent, once per process). */
export function ensurePlans(): Promise<void> {
  seeded ??= seedPlans().catch((err) => {
    seeded = null;
    throw err;
  });
  return seeded;
}

/** Base plans (Starter/Growth/Business) by default; pass kind "ADDON" for add-ons or "ALL". */
export async function listPlans(includeInactive = false, kind: "BASE" | "ADDON" | "ALL" = "BASE") {
  await ensurePlans();
  const find = () =>
    prisma.pricingPlan.findMany({
      where: { ...(includeInactive ? {} : { active: true }), ...(kind === "ALL" ? {} : { kind }) },
      orderBy: { sortOrder: "asc" },
    });
  const plans = await find();
  if (plans.length) return plans;
  await seedPlans(); // catalog table was emptied after this process seeded it
  return find();
}

export async function getPlanByCode(code: string) {
  await ensurePlans();
  const plan = await prisma.pricingPlan.findUnique({ where: { code } });
  if (plan || !DEFAULT_PLANS.some((p) => p.code === code)) return plan;
  await seedPlans();
  return prisma.pricingPlan.findUnique({ where: { code } });
}

export function annualEnabled(plan?: Pick<PricingPlan, "annualPricePaise">): boolean {
  return env().BILLING_ANNUAL_ENABLED && (plan ? plan.annualPricePaise !== null && plan.annualPricePaise > 0 : true);
}

export interface PriceBreakdown {
  cycle: BillingCycle;
  /** Price before tax. */
  subtotalPaise: number;
  taxPaise: number;
  taxRateBp: number;
  /** Amount actually charged. */
  totalPaise: number;
  currency: string;
  pricesIncludeTax: boolean;
}

/** Server-side source of truth for what a plan costs per billing cycle. */
export function priceFor(plan: Pick<PricingPlan, "monthlyPricePaise" | "annualPricePaise" | "currency">, cycle: BillingCycle): PriceBreakdown {
  const e = env();
  const base = cycle === "ANNUAL" ? plan.annualPricePaise : plan.monthlyPricePaise;
  if (base === null || base === undefined) throw new Error("Billing cycle not offered for this plan");
  const rate = e.BILLING_TAX_RATE_BP;
  let subtotal: number;
  let total: number;
  if (e.BILLING_PRICES_INCLUDE_TAX) {
    total = base;
    subtotal = Math.round((base * 10_000) / (10_000 + rate));
  } else {
    subtotal = base;
    total = base + Math.round((base * rate) / 10_000);
  }
  return {
    cycle,
    subtotalPaise: subtotal,
    taxPaise: total - subtotal,
    taxRateBp: rate,
    totalPaise: total,
    currency: plan.currency,
    pricesIncludeTax: e.BILLING_PRICES_INCLUDE_TAX,
  };
}

export function formatInr(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: rupees % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** Public representation for the pricing page and API. */
export function presentPlan(plan: PricingPlan) {
  const monthly = priceFor(plan, "MONTHLY");
  const annual = annualEnabled(plan) ? priceFor(plan, "ANNUAL") : null;
  return {
    code: plan.code,
    name: plan.name,
    tagline: plan.tagline,
    description: plan.description,
    features: plan.features as string[],
    highlight: plan.highlight,
    limits: {
      websites: plan.maxWebsites,
      members: plan.maxMembers,
      availabilityIntervalSec: plan.availabilityIntervalSec,
      aiAssistant: plan.aiAssistant,
      scheduledReports: plan.scheduledReports,
      auditLogs: plan.auditLogs,
    },
    monthly,
    annual,
  };
}

export type PublicPlan = ReturnType<typeof presentPlan>;

const RANK: Record<string, number> = { STARTER: 1, GROWTH: 2, BUSINESS: 3 };
/** Higher = more capable plan. Unknown codes rank by website limit. */
export function planRank(plan: Pick<PricingPlan, "code" | "maxWebsites">): number {
  return RANK[plan.code] ?? plan.maxWebsites;
}

import { execSync } from "node:child_process";
import type { OrgRole } from "@prisma/client";
import { prisma } from "@/server/db";
import { randomToken } from "@/server/security/crypto";
import { seedPlans } from "@/server/billing/plans";

let migrated = false;

/** True when a test database is configured (integration tests are skipped otherwise). */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

export async function migrateTestDb() {
  if (migrated) return;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, stdio: "pipe" });
  migrated = true;
}

export async function resetDb() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
}

/**
 * Creates a user + org. By default the org gets a complimentary BUSINESS entitlement so tests
 * of monitoring/website features are not blocked by billing; pass plan: null for an unpaid org.
 */
export async function makeOrg(name: string, role: OrgRole = "OWNER", opts: { plan?: string | null } = {}) {
  const user = await prisma.user.create({
    data: { email: `${name.toLowerCase()}-${randomToken(4)}@example.com`, name, passwordHash: "x" },
  });
  const org = await prisma.organization.create({ data: { name: `${name} Org`, slug: `${name.toLowerCase()}-${randomToken(4)}` } });
  await prisma.membership.create({ data: { userId: user.id, orgId: org.id, role } });
  const planCode = opts.plan === undefined ? "BUSINESS" : opts.plan;
  if (planCode) await grantPlan(org.id, planCode);
  return { user, org, actor: { userId: user.id, orgId: org.id, role, ip: "test" } };
}

export async function grantPlan(orgId: string, planCode: string, days = 30) {
  await seedPlans();
  const plan = await prisma.pricingPlan.findUniqueOrThrow({ where: { code: planCode } });
  const now = new Date();
  return prisma.subscription.create({
    data: {
      orgId,
      planId: plan.id,
      cycle: "MONTHLY",
      mode: "COMPLIMENTARY",
      status: "ACTIVE",
      amountPaise: 0,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + days * 86_400_000),
      grantReason: "test",
    },
  });
}

export async function makeConnectedSite(orgId: string, hostname = `site-${randomToken(3).toLowerCase()}.example.com`) {
  return prisma.website.create({
    data: {
      orgId,
      hostname,
      url: `https://${hostname}/`,
      displayName: hostname,
      status: "CONNECTED",
      verificationToken: randomToken(32),
      verificationMethod: "DNS_TXT",
      verifiedAt: new Date(),
      authorizationConfirmedAt: new Date(),
    },
  });
}

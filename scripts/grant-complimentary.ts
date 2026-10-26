/**
 * Grants complimentary (unpaid, clearly labelled) access to an organization, e.g. to migrate
 * customers who existed before billing, or for TrustifyX's own websites. Creates no payment.
 *
 * Usage: npm run billing:grant -- <owner-email> <STARTER|GROWTH|BUSINESS> <days> "<reason>"
 */
import { prisma } from "../src/server/db";
import { adminGrantComplimentary } from "../src/server/billing/admin";
import { seedPlans } from "../src/server/billing/plans";

async function main() {
  const [email, planCode, daysArg, reason] = process.argv.slice(2);
  if (!email || !planCode || !daysArg || !reason) {
    console.error('Usage: npm run billing:grant -- <owner-email> <PLAN> <days> "<reason>"');
    process.exit(2);
  }
  await seedPlans();
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw new Error(`No user ${email}`);
  const membership = await prisma.membership.findFirst({ where: { userId: user.id, role: "OWNER" }, include: { org: true }, orderBy: { createdAt: "asc" } });
  if (!membership) throw new Error(`${email} does not own an organization`);
  const sub = await adminGrantComplimentary(user.id, { orgId: membership.orgId, planCode: planCode.toUpperCase(), days: Number(daysArg), reason });
  console.log(`Granted ${planCode.toUpperCase()} to "${membership.org.name}" until ${sub.currentPeriodEnd?.toISOString()} (subscription ${sub.id})`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

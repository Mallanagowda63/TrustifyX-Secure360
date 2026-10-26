/**
 * Grants or revokes TrustifyX platform-administrator access (operator tenant overview).
 * Usage: npm run admin:promote -- user@company.com [--revoke]
 */
import { PrismaClient } from "@prisma/client";

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: npm run admin:promote -- <email> [--revoke]");
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const isPlatformAdmin = flag !== "--revoke";
  const user = await prisma.user.update({ where: { email: email.trim().toLowerCase() }, data: { isPlatformAdmin } }).catch(() => null);
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  await prisma.auditLog.create({ data: { userId: user.id, action: isPlatformAdmin ? "platform.admin_granted" : "platform.admin_revoked", metadata: { via: "cli" } } });
  console.log(`${user.email}: platform admin = ${isPlatformAdmin}`);
  await prisma.$disconnect();
}

void main();

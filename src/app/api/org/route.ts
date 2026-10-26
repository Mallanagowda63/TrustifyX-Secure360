import { z } from "zod";
import { authedRoute, readJson } from "@/server/api";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { listMembers } from "@/server/services/auth";
import { nameSchema } from "@/server/validation";

export const GET = authedRoute("team.read", async ({ ctx }) => ({
  org: ctx.org,
  role: ctx.role,
  ...(await listMembers(ctx.org.id)),
}));

export const PATCH = authedRoute("org.update", async ({ req, ctx }) => {
  const { name } = await readJson(req, z.object({ name: nameSchema }).strict());
  const org = await prisma.organization.update({ where: { id: ctx.org.id }, data: { name }, select: { id: true, name: true, slug: true } });
  await audit({ orgId: ctx.org.id, userId: ctx.user.id, ip: ctx.ip, action: "org.update", metadata: { name } });
  return { org };
});

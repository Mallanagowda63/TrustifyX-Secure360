import { z } from "zod";
import { ApiError, authedRoute, readJson } from "@/server/api";
import { audit } from "@/server/audit";
import { prisma } from "@/server/db";
import { listMembers } from "@/server/services/auth";
import { nameSchema } from "@/server/validation";

export const GET = authedRoute("team.read", async ({ ctx }) => ({
  org: ctx.org,
  role: ctx.role,
  ...(await listMembers(ctx.org.id)),
}));

const patchBody = z
  .object({ name: nameSchema.optional(), requireMfaForPrivileged: z.boolean().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.requireMfaForPrivileged !== undefined, { message: "Nothing to update" });

export const PATCH = authedRoute("org.update", async ({ req, ctx }) => {
  const input = await readJson(req, patchBody);
  // An owner can only enforce 2FA after protecting their own account, so they cannot lock themselves out.
  if (input.requireMfaForPrivileged && !ctx.user.totpEnabledAt) {
    throw new ApiError(400, "Set up two-factor authentication on your own account before requiring it for owners and admins.", "mfa_required");
  }
  const org = await prisma.organization.update({
    where: { id: ctx.org.id },
    data: input,
    select: { id: true, name: true, slug: true, requireMfaForPrivileged: true },
  });
  await audit({ orgId: ctx.org.id, userId: ctx.user.id, ip: ctx.ip, action: "org.update", metadata: input });
  return { org };
});

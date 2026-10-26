import { ApiError, publicRoute } from "@/server/api";
import { prisma } from "@/server/db";

/**
 * TrustifyX operator view: tenant list with usage counts only. Platform admins do not
 * get access to customers' findings, checks or configuration through this endpoint.
 */
export const GET = publicRoute(async ({ session }) => {
  if (!session) throw new ApiError(401, "Authentication required", "unauthenticated");
  if (!session.user.isPlatformAdmin) throw new ApiError(403, "Platform administrator access required", "forbidden");
  const orgs = await prisma.organization.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { memberships: true, websites: true } },
    },
  });
  return {
    organizations: orgs.map((o) => ({ id: o.id, name: o.name, createdAt: o.createdAt, members: o._count.memberships, websites: o._count.websites })),
  };
});

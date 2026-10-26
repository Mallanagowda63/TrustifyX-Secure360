import { authedRoute } from "@/server/api";
import { prisma } from "@/server/db";

export const GET = authedRoute("report.read", async ({ ctx }) => ({
  reports: await prisma.report.findMany({
    where: { orgId: ctx.org.id },
    orderBy: { periodStart: "desc" },
    take: 50,
    select: { id: true, period: true, periodStart: true, periodEnd: true, createdAt: true, aiSummary: true },
  }),
}));

import { prisma } from "../db";

/**
 * Ends open downtime incidents when monitoring stops (pause, lost verification, billing):
 * no recovery check will ever run to close them.
 */
export async function closeOpenDowntime(websiteId: string, reason: string) {
  const open = await prisma.incident.findMany({ where: { websiteId, type: "DOWNTIME", resolvedAt: null } });
  for (const inc of open) {
    await prisma.incident.update({
      where: { id: inc.id },
      data: { resolvedAt: new Date(), details: { ...((inc.details as object | null) ?? {}), closedBecause: reason } },
    });
  }
  return open.length;
}

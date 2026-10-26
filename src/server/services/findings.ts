import type { FindingStatus, Prisma, Severity } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../audit";
import { ApiError, notFound } from "../api";
import { enqueueConfig } from "../queue";
import { assertCan, type Actor } from "./actor";

export const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export async function listFindings(
  orgId: string,
  filter: { status?: FindingStatus[]; severity?: Severity[]; websiteId?: string; take?: number } = {},
) {
  const where: Prisma.FindingWhereInput = {
    orgId,
    ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    ...(filter.severity?.length ? { severity: { in: filter.severity } } : {}),
    ...(filter.websiteId ? { websiteId: filter.websiteId } : {}),
  };
  const rows = await prisma.finding.findMany({
    where,
    include: { website: { select: { id: true, displayName: true, hostname: true } } },
    orderBy: [{ lastSeenAt: "desc" }],
    take: Math.min(filter.take ?? 500, 1000),
  });
  // Sort by severity first, then recency.
  return rows.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export async function getFinding(orgId: string, id: string) {
  const f = await prisma.finding.findFirst({
    where: { id, orgId },
    include: { website: { select: { id: true, displayName: true, hostname: true } } },
  });
  if (!f) throw notFound("Finding");
  return f;
}

export async function updateFindingStatus(actor: Actor, id: string, input: { status: FindingStatus; note?: string }) {
  assertCan(actor, "finding.update");
  const f = await getFinding(actor.orgId, id);
  if (input.status === "FALSE_POSITIVE" && !input.note?.trim()) {
    throw new ApiError(400, "Please explain why this is a false positive", "note_required");
  }
  const now = new Date();
  const updated = await prisma.finding.update({
    where: { id: f.id },
    data: {
      status: input.status,
      statusNote: input.note?.trim().slice(0, 1000) || null,
      statusChangedById: actor.userId,
      statusChangedAt: now,
      resolvedAt: input.status === "RESOLVED" ? now : input.status === "FALSE_POSITIVE" ? f.resolvedAt : null,
    },
    include: { website: { select: { id: true, displayName: true, hostname: true } } },
  });
  await audit({
    orgId: actor.orgId,
    userId: actor.userId,
    ip: actor.ip,
    action: "finding.status_changed",
    targetType: "finding",
    targetId: f.id,
    metadata: { from: f.status, to: input.status, note: input.note ?? null },
  });
  // Marking "Resolved" manually triggers a verification rescan; the engine reopens it if still observed.
  if (input.status === "RESOLVED") await enqueueConfig(f.websiteId, { priority: 1 }).catch(() => undefined);
  return updated;
}

export async function severityCounts(orgId: string) {
  const rows = await prisma.finding.groupBy({
    by: ["severity"],
    where: { orgId, status: { in: ["OPEN", "IN_PROGRESS"] } },
    _count: { _all: true },
  });
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const r of rows) counts[r.severity] = r._count._all;
  return counts;
}

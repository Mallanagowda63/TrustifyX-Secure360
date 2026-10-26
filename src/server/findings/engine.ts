import type { Finding, Prisma, PrismaClient } from "@prisma/client";
import type { ConfigCategory } from "../monitoring/types";
import type { Observation } from "./rules";

export interface FindingChanges {
  opened: Finding[];
  reopened: Finding[];
  resolved: Finding[];
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Reconciles this run's observations with stored findings for one website.
 *  - new rule hit            → create OPEN finding
 *  - RESOLVED rule hit again → reopen (regression)
 *  - FALSE_POSITIVE hit      → keep the customer's decision, refresh evidence
 *  - OPEN/IN_PROGRESS not observed, in a category that ran successfully → RESOLVED
 */
export async function reconcileFindings(
  db: Db,
  params: {
    orgId: string;
    websiteId: string;
    observations: Observation[];
    evaluatedCategories: ConfigCategory[];
    now?: Date;
  },
): Promise<FindingChanges> {
  const now = params.now ?? new Date();
  const existing = await db.finding.findMany({ where: { websiteId: params.websiteId, orgId: params.orgId } });
  const byRule = new Map(existing.map((f) => [f.ruleId, f]));
  const seen = new Set<string>();
  const changes: FindingChanges = { opened: [], reopened: [], resolved: [] };

  for (const obs of params.observations) {
    seen.add(obs.ruleId);
    const prev = byRule.get(obs.ruleId);
    const content = {
      category: obs.category,
      title: obs.title,
      severity: obs.severity,
      evidence: obs.evidence as Prisma.InputJsonValue,
      description: obs.description,
      remediation: obs.remediation,
      lastSeenAt: now,
    };
    if (!prev) {
      const created = await db.finding.create({
        data: { ...content, orgId: params.orgId, websiteId: params.websiteId, ruleId: obs.ruleId, firstSeenAt: now },
      });
      changes.opened.push(created);
    } else if (prev.status === "RESOLVED") {
      const updated = await db.finding.update({
        where: { id: prev.id },
        data: { ...content, status: "OPEN", resolvedAt: null, statusNote: "Reopened: observed again by automated check" },
      });
      changes.reopened.push(updated);
    } else {
      await db.finding.update({ where: { id: prev.id }, data: content });
    }
  }

  const ranCategories = new Set(params.evaluatedCategories);
  for (const f of existing) {
    if (seen.has(f.ruleId)) continue;
    if (f.status !== "OPEN" && f.status !== "IN_PROGRESS") continue;
    if (!ranCategories.has(f.category as ConfigCategory)) continue;
    const updated = await db.finding.update({
      where: { id: f.id },
      data: { status: "RESOLVED", resolvedAt: now, statusNote: "Resolved: no longer observed by automated check" },
    });
    changes.resolved.push(updated);
  }
  return changes;
}

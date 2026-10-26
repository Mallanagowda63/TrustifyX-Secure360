import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

export interface AuditEntry {
  orgId?: string | null;
  userId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Append-only audit trail. Failures are logged but never break the caller's request. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: entry.orgId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ip: entry.ip ?? null,
        metadata: entry.metadata,
      },
    });
  } catch (err) {
    console.error("[audit] failed to write audit log", entry.action, (err as Error).message);
  }
}

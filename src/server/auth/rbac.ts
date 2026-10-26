import type { OrgRole } from "@prisma/client";

const RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function roleAtLeast(role: OrgRole, min: OrgRole): boolean {
  return RANK[role] >= RANK[min];
}

/** Minimum org role required for each action. Enforced server-side on every request. */
export const PERMISSIONS = {
  "website.read": "VIEWER",
  "website.create": "MEMBER",
  "website.verify": "MEMBER",
  "website.scan": "MEMBER",
  "website.update": "ADMIN",
  "website.delete": "ADMIN",
  "finding.read": "VIEWER",
  "finding.update": "MEMBER",
  "alert.read": "VIEWER",
  "report.read": "VIEWER",
  "ai.use": "MEMBER",
  "integration.read": "VIEWER",
  "integration.manage": "ADMIN",
  "team.read": "VIEWER",
  "team.manage": "ADMIN",
  "org.update": "OWNER",
  "audit.read": "ADMIN",
  "billing.read": "VIEWER",
  "billing.manage": "ADMIN",
} as const satisfies Record<string, OrgRole>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: OrgRole, permission: Permission): boolean {
  return roleAtLeast(role, PERMISSIONS[permission]);
}

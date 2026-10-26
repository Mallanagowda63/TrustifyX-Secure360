import type { OrgRole } from "@prisma/client";
import { ApiError } from "../api";
import { can, type Permission } from "../auth/rbac";

/** Who is acting, and in which tenant. Every service function takes this instead of trusting client input. */
export interface Actor {
  userId: string;
  orgId: string;
  role: OrgRole;
  ip?: string | null;
}

export function assertCan(actor: Actor, permission: Permission) {
  if (!can(actor.role, permission)) throw new ApiError(403, "You do not have permission to perform this action", "forbidden");
}

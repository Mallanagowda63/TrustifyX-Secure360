import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { changeMemberRole, removeMember } from "@/server/services/auth";
import { roleSchema } from "@/server/validation";

export const PATCH = authedRoute<{ id: string }>("team.manage", async ({ req, ctx, params }) => {
  const { role } = await readJson(req, z.object({ role: roleSchema }));
  return { member: await changeMemberRole(actorOf(ctx), params.id, role) };
});

// Permission checked in the service: members may remove themselves (leave).
export const DELETE = authedRoute<{ id: string }>(null, async ({ ctx, params }) => {
  await removeMember(actorOf(ctx), params.id);
  return { ok: true };
});

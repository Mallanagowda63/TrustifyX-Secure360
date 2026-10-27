import { z } from "zod";
import { authedRoute, readJson } from "@/server/api";
import { audit } from "@/server/audit";
import { switchOrg } from "@/server/services/auth";
import { idSchema } from "@/server/validation";

export const POST = authedRoute(
  null,
  async ({ req, ctx }) => {
    const { orgId } = await readJson(req, z.object({ orgId: idSchema }));
    await switchOrg(ctx.session.id, ctx.user.id, orgId);
    await audit({ orgId, userId: ctx.user.id, ip: ctx.ip, action: "auth.switch_org" });
    return { ok: true };
  },
  // Must stay reachable so a user blocked by one organization's 2FA policy can switch away.
  { mfaExempt: true },
);

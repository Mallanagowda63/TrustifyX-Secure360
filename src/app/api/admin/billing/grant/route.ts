import { z } from "zod";
import { adminRoute, readJson } from "@/server/api";
import { adminGrantComplimentary } from "@/server/billing/admin";

const body = z
  .object({ orgId: z.string().min(1).max(64), planCode: z.string().max(40), days: z.number().int().min(1).max(366), reason: z.string().trim().min(3).max(300) })
  .strict();

/** Complimentary access (e.g. TrustifyX's own sites, pilots). Never creates payment records. */
export const POST = adminRoute(async ({ req, ctx }) => ({ subscription: await adminGrantComplimentary(ctx.user.id, await readJson(req, body)) }));

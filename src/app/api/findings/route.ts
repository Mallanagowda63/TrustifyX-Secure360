import { z } from "zod";
import { authedRoute } from "@/server/api";
import { listFindings } from "@/server/services/findings";
import { findingStatusSchema, idSchema, severitySchema } from "@/server/validation";

const list = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : []))
    .pipe(z.array(item));

const query = z.object({
  status: list(findingStatusSchema),
  severity: list(severitySchema),
  websiteId: idSchema.optional(),
});

export const GET = authedRoute("finding.read", async ({ req, ctx }) => {
  const sp = req.nextUrl.searchParams;
  const q = query.parse({
    status: sp.get("status") ?? undefined,
    severity: sp.get("severity") ?? undefined,
    websiteId: sp.get("websiteId") ?? undefined,
  });
  return { findings: await listFindings(ctx.org.id, q) };
});

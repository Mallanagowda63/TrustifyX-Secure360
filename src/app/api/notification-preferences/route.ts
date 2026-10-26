import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { getPreferences, updatePreferences } from "@/server/services/dashboard";
import { severitySchema } from "@/server/validation";

export const GET = authedRoute(null, async ({ ctx }) => ({ preferences: await getPreferences(ctx.org.id, ctx.user.id) }));

const body = z
  .object({
    emailDowntime: z.boolean(),
    emailTlsExpiry: z.boolean(),
    emailFindings: z.boolean(),
    findingMinSeverity: severitySchema,
    emailWeeklyReport: z.boolean(),
    emailMonthlyReport: z.boolean(),
  })
  .partial()
  .strict();

export const PUT = authedRoute(null, async ({ req, ctx }) => ({
  preferences: await updatePreferences(actorOf(ctx), await readJson(req, body)),
}));

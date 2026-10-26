import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { getFinding, updateFindingStatus } from "@/server/services/findings";
import { findingStatusSchema } from "@/server/validation";

export const GET = authedRoute<{ id: string }>("finding.read", async ({ ctx, params }) => ({
  finding: await getFinding(ctx.org.id, params.id),
}));

const body = z.object({ status: findingStatusSchema, note: z.string().max(1000).optional() });

export const PATCH = authedRoute<{ id: string }>("finding.update", async ({ req, ctx, params }) => ({
  finding: await updateFindingStatus(actorOf(ctx), params.id, await readJson(req, body)),
}));

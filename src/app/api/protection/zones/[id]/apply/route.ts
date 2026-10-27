import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { applyChanges } from "@/server/protection/service";

const body = z.object({
  features: z.array(z.string().max(60)).min(1).max(20),
  mode: z.enum(["enforce", "preview"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});

/** Step 2: applies the reviewed changes after explicit confirmation; each is verified by reading it back. */
export const POST = authedRoute<{ id: string }>("protection.manage", async ({ req, ctx, params }) => {
  const input = await readJson(req, body);
  return applyChanges(actorOf(ctx), params.id, { keys: input.features, mode: input.mode, fingerprint: input.fingerprint, confirm: true });
});

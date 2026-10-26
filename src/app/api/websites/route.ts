import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, readJson, actorOf } from "@/server/api";
import { createWebsite, listWebsites } from "@/server/services/websites";

export const GET = authedRoute("website.read", async ({ ctx }) => ({ websites: await listWebsites(ctx.org.id) }));

const body = z.object({
  url: z.string().trim().min(1).max(2048),
  displayName: z.string().trim().max(100).optional(),
});

export const POST = authedRoute("website.create", async ({ req, ctx }) => {
  const input = await readJson(req, body);
  const website = await createWebsite(actorOf(ctx), input);
  return NextResponse.json({ website }, { status: 201 });
});

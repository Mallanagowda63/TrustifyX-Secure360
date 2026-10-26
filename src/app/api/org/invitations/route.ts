import { NextResponse } from "next/server";
import { z } from "zod";
import { actorOf, authedRoute, readJson } from "@/server/api";
import { inviteMember } from "@/server/services/auth";
import { emailSchema, roleSchema } from "@/server/validation";

const body = z.object({ email: emailSchema, role: roleSchema });

export const POST = authedRoute("team.manage", async ({ req, ctx }) =>
  NextResponse.json({ invitation: await inviteMember(actorOf(ctx), await readJson(req, body)) }, { status: 201 }),
);

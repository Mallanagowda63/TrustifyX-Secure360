import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { withSessionCookies } from "@/server/auth/cookies";
import { signup } from "@/server/services/auth";
import { emailSchema, nameSchema, passwordSchema } from "@/server/validation";

const body = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, orgName: nameSchema });

export const POST = publicRoute(
  async ({ req, ip }) => {
    const input = await readJson(req, body);
    const { user, org, session } = await signup(input, { ip, userAgent: req.headers.get("user-agent") });
    return withSessionCookies(NextResponse.json({ user: { id: user.id, email: user.email, name: user.name }, org }, { status: 201 }), session);
  },
  { rateLimit: { key: "signup", limit: 5, windowSec: 3600 } },
);

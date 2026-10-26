import { NextResponse } from "next/server";
import { z } from "zod";
import { publicRoute, readJson } from "@/server/api";
import { withSessionCookies } from "@/server/auth/cookies";
import { login } from "@/server/services/auth";
import { emailSchema, passwordSchema } from "@/server/validation";

const body = z.object({ email: emailSchema, password: passwordSchema });

export const POST = publicRoute(
  async ({ req, ip }) => {
    const input = await readJson(req, body);
    const { user, session } = await login(input, { ip, userAgent: req.headers.get("user-agent") });
    return withSessionCookies(NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } }), session);
  },
  { rateLimit: { key: "login", limit: 30, windowSec: 900 } },
);

import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, publicRoute, readJson } from "@/server/api";
import { withSessionCookies } from "@/server/auth/cookies";
import { signup } from "@/server/services/auth";
import { emailSchema, nameSchema, passwordSchema } from "@/server/validation";

const body = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema, orgName: nameSchema });

export const POST = publicRoute(
  async ({ req, ip, site }) => {
    if (site === "PORTAL") throw new ApiError(404, "Sign up on the TrustifyX Secure360 website", "not_found");
    const input = await readJson(req, body);
    const { user, org, session } = await signup(input, { ip, userAgent: req.headers.get("user-agent"), site });
    return withSessionCookies(NextResponse.json({ user: { id: user.id, email: user.email, name: user.name }, org }, { status: 201 }), session);
  },
  { rateLimit: { key: "signup", limit: 5, windowSec: 3600 } },
);

import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, publicRoute, readJson } from "@/server/api";
import { withSessionCookies } from "@/server/auth/cookies";
import { acceptInvitation, switchOrg } from "@/server/services/auth";
import { safeEqual } from "@/server/security/crypto";

const body = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().max(100).optional(),
  password: z.string().max(128).optional(),
});

export const POST = publicRoute(
  async ({ req, ip, site, session }) => {
    const input = await readJson(req, body);
    if (session) {
      const header = req.headers.get("x-csrf-token") ?? "";
      if (!safeEqual(header, session.session.csrfToken)) throw new ApiError(403, "Invalid CSRF token", "csrf");
    }
    const result = await acceptInvitation(
      input,
      session ? { userId: session.user.id, email: session.user.email } : null,
      { ip, userAgent: req.headers.get("user-agent"), site },
    );
    if (session) await switchOrg(session.session.id, session.user.id, result.orgId);
    const res = NextResponse.json({ ok: true, orgId: result.orgId });
    return result.session ? withSessionCookies(res, result.session) : res;
  },
  { rateLimit: { key: "invite-accept", limit: 10, windowSec: 900 } },
);

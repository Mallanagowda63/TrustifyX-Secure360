import { ApiError, publicRoute } from "@/server/api";
import { findInvitation } from "@/server/services/auth";

export const GET = publicRoute<{ token: string }>(
  async ({ params }) => {
    const inv = await findInvitation(params.token);
    if (!inv) throw new ApiError(404, "This invitation is invalid or has expired");
    return { email: inv.email, role: inv.role, orgName: inv.org.name, expiresAt: inv.expiresAt };
  },
  { rateLimit: { key: "invite-lookup", limit: 30, windowSec: 600 } },
);

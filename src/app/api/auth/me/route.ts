import { ApiError, publicRoute } from "@/server/api";
import { listUserOrgs } from "@/server/services/auth";

export const GET = publicRoute(async ({ session }) => {
  if (!session) throw new ApiError(401, "Authentication required", "unauthenticated");
  return {
    user: session.user,
    org: session.org,
    role: session.role,
    orgs: await listUserOrgs(session.user.id),
    csrfToken: session.session.csrfToken,
  };
});

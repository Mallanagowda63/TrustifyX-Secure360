import { redirect } from "next/navigation";
import { getPageSession } from "@/server/auth/page";
import { marketingUrl } from "@/server/sites";
import { safeNextPath } from "@/lib/site-routing";
import { PortalLoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function PortalLoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; reset?: string }> }) {
  const sp = await searchParams;
  const next = safeNextPath("PORTAL", sp.next, "/");
  if (await getPageSession()) redirect(next);
  return (
    <PortalLoginForm
      next={next}
      plansUrl={marketingUrl("/#pricing")}
      notice={sp.reset ? "Your password was changed. Please sign in." : sp.error === "sso" ? "Your sign-in link expired. Please sign in with your email and password." : sp.error === "no_org" ? "Your account is not a member of any organization." : null}
    />
  );
}

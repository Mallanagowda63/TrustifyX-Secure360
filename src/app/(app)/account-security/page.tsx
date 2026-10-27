import { requirePageSession } from "@/server/auth/page";
import { mfaStatus } from "@/server/auth/mfa";
import { PageHeader } from "@/components/ui";
import { AccountSecurityView } from "./account-security-view";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  // Reachable even when an organization's 2FA policy blocks the rest of the portal.
  const s = await requirePageSession(undefined, { mfaExempt: true });
  const sp = await searchParams;
  const status = await mfaStatus(s.user.id);
  return (
    <div>
      <PageHeader title="Account Security" subtitle={`Signed in as ${s.user.email}`} />
      <AccountSecurityView
        initial={JSON.parse(JSON.stringify(status))}
        requiredNotice={sp.required === "admin" ? "admin" : sp.required ? "org" : null}
        org={{ name: s.org.name, requireMfaForPrivileged: s.org.requireMfaForPrivileged }}
        isOwner={s.role === "OWNER"}
      />
    </div>
  );
}

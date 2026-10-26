import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listFindings } from "@/server/services/findings";
import { aiEnabled } from "@/server/ai/provider";
import { getEntitlement } from "@/server/billing/entitlements";
import { PageHeader } from "@/components/ui";
import { FindingsView } from "./findings-view";

export default async function FindingsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const s = await requirePageSession("finding.read");
  const [findings, sp] = await Promise.all([listFindings(s.org.id), searchParams]);
  return (
    <div>
      <PageHeader
        title="Security findings"
        subtitle="Verified observations from external checks, with the evidence behind each one. Missing hardening headers are configuration gaps, not signs of an attack."
      />
      <FindingsView
        initial={JSON.parse(JSON.stringify(findings))}
        selectedId={sp.id ?? null}
        canUpdate={can(s.role, "finding.update")}
        canScan={can(s.role, "website.scan")}
        aiEnabled={aiEnabled() && can(s.role, "ai.use") && (await getEntitlement(s.org.id)).limits.aiAssistant}
      />
    </div>
  );
}

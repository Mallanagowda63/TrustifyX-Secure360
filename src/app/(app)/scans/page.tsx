import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listScans, scanUsage } from "@/server/scanning/service";
import { PageHeader } from "@/components/ui";
import { ScansView } from "./scans-view";

export const dynamic = "force-dynamic";

export default async function ScansPage() {
  const s = await requirePageSession("scan.read");
  const [data, usage] = await Promise.all([listScans(s.org.id), scanUsage(s.org.id)]);
  return (
    <div>
      <PageHeader
        title="Vulnerability Scanning"
        subtitle="Authorized OWASP ZAP scans of your verified websites. Passive baseline scans are the default; active scans need a separate authorization and a maintenance window."
      />
      <ScansView initial={JSON.parse(JSON.stringify({ ...data, usage }))} canManage={can(s.role, "scan.manage")} />
    </div>
  );
}

import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { serverOverview } from "@/server/servers/service";
import { PageHeader } from "@/components/ui";
import { ServersView } from "./servers-view";

export const dynamic = "force-dynamic";

export default async function ServersPage() {
  const s = await requirePageSession("server.read");
  const data = await serverOverview(s.org.id);
  return (
    <div>
      <PageHeader
        title="Server Security"
        subtitle="File integrity, malware-related and security-log alerts from the Wazuh agent on servers you control. Monitoring is only active once an agent is installed and sending data."
      />
      <ServersView initial={JSON.parse(JSON.stringify(data))} canManage={can(s.role, "server.manage")} />
    </div>
  );
}

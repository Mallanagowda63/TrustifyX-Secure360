import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { protectionOverview } from "@/server/protection/service";
import { PageHeader } from "@/components/ui";
import { ProtectionView } from "./protection-view";

export const dynamic = "force-dynamic";

export default async function ProtectionPage() {
  const s = await requirePageSession("protection.read");
  const overview = await protectionOverview(s.org.id);
  return (
    <div>
      <PageHeader
        title="Firewall & Protection"
        subtitle="Cloudflare-based protection for your verified websites. Nothing changes in Cloudflare until you review and confirm it."
      />
      <ProtectionView initial={JSON.parse(JSON.stringify(overview))} canManage={can(s.role, "protection.manage")} />
    </div>
  );
}

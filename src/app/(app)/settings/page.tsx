import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listMembers } from "@/server/services/auth";
import { getPreferences } from "@/server/services/dashboard";
import { PageHeader } from "@/components/ui";
import { SettingsView } from "./settings-view";

export default async function SettingsPage() {
  const s = await requirePageSession("team.read");
  const [team, prefs] = await Promise.all([listMembers(s.org.id), getPreferences(s.org.id, s.user.id)]);
  return (
    <div>
      <PageHeader title="Settings" subtitle={`Organization: ${s.org.name}`} />
      <SettingsView
        org={s.org}
        me={{ id: s.user.id, role: s.role }}
        team={JSON.parse(JSON.stringify(team))}
        prefs={prefs}
        canManageTeam={can(s.role, "team.manage")}
        canRenameOrg={can(s.role, "org.update")}
      />
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Notice, Section } from "@/components/ui";
import { fmtDate, timeAgo } from "@/lib/format";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
interface Team {
  members: Array<{ id: string; role: Role; joinedAt: string; user: { id: string; name: string; email: string; lastLoginAt: string | null } }>;
  invitations: Array<{ id: string; email: string; role: Role; expiresAt: string }>;
}
interface Prefs {
  emailDowntime: boolean;
  emailTlsExpiry: boolean;
  emailFindings: boolean;
  findingMinSeverity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  emailWeeklyReport: boolean;
  emailMonthlyReport: boolean;
}

const ROLES: Array<{ v: Role; label: string; desc: string }> = [
  { v: "OWNER", label: "Owner", desc: "Full control including organization settings" },
  { v: "ADMIN", label: "Admin", desc: "Manage websites, team and integrations" },
  { v: "MEMBER", label: "Member", desc: "Add and verify websites, triage findings" },
  { v: "VIEWER", label: "Viewer", desc: "Read-only access" },
];

export function SettingsView({
  org,
  me,
  team,
  prefs,
  canManageTeam,
  canRenameOrg,
}: {
  org: { id: string; name: string };
  me: { id: string; role: Role };
  team: Team;
  prefs: Prefs;
  canManageTeam: boolean;
  canRenameOrg: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [p, setP] = useState<Prefs>(prefs);
  const ownerCount = team.members.filter((m) => m.role === "OWNER").length;

  async function act(fn: () => Promise<unknown>, success: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "success", text: success });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
    }
  }

  return (
    <div className="space-y-6">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Section title="Notifications (your account)">
        <div className="grid gap-3 text-sm md:grid-cols-2">
          {(
            [
              ["emailDowntime", "Email me when downtime is confirmed and when a site recovers"],
              ["emailTlsExpiry", "Email me before TLS certificates expire (30, 14, 7, 3, 1 days)"],
              ["emailFindings", "Email me about new and resolved security findings"],
              ["emailWeeklyReport", "Weekly PDF security report"],
              ["emailMonthlyReport", "Monthly PDF security report"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
          <label className="flex items-center gap-2">
            <span>Minimum finding severity to email:</span>
            <select className="input w-auto py-1" value={p.findingMinSeverity} onChange={(e) => setP({ ...p, findingMinSeverity: e.target.value as Prefs["findingMinSeverity"] })}>
              {["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <button className="btn btn-primary mt-4" onClick={() => act(() => api("/api/notification-preferences", { method: "PUT", body: p }), "Notification preferences saved.")}>
          Save preferences
        </button>
      </Section>

      {canRenameOrg && (
        <Section title="Organization">
          <form
            className="flex max-w-lg gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name"));
              void act(() => api("/api/org", { method: "PATCH", body: { name } }), "Organization renamed.");
            }}
          >
            <input name="name" className="input" defaultValue={org.name} maxLength={100} required aria-label="Organization name" />
            <button className="btn btn-primary">Rename</button>
          </form>
        </Section>
      )}

      <Section title={`Team (${team.members.length})`}>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {team.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="font-medium">
                      {m.user.name} {m.user.id === me.id && <span className="text-xs text-ink-faint">(you)</span>}
                    </div>
                    <div className="text-xs text-ink-faint">{m.user.email}</div>
                  </td>
                  <td>
                    {canManageTeam && m.user.id !== me.id ? (
                      <select
                        className="input w-auto py-1"
                        defaultValue={m.role}
                        onChange={(e) => act(() => api(`/api/org/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }), "Role updated.")}
                        aria-label={`Role for ${m.user.email}`}
                      >
                        {ROLES.map((r) => (
                          <option key={r.v} value={r.v}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLES.find((r) => r.v === m.role)?.label
                    )}
                  </td>
                  <td className="text-ink-muted">{timeAgo(m.user.lastLoginAt)}</td>
                  <td className="text-right">
                    {(canManageTeam || m.user.id === me.id) && !(m.role === "OWNER" && ownerCount === 1) && (
                      <button
                        className="btn btn-danger py-1"
                        onClick={() => {
                          if (!confirm(m.user.id === me.id ? "Leave this organization?" : `Remove ${m.user.email}?`)) return;
                          void act(() => api(`/api/org/members/${m.id}`, { method: "DELETE" }), m.user.id === me.id ? "You left the organization." : "Member removed.");
                        }}
                      >
                        {m.user.id === me.id ? "Leave" : "Remove"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManageTeam && (
          <div className="mt-6 space-y-3 border-t border-navy-700 pt-4">
            <h3 className="text-sm font-semibold">Invite a teammate</h3>
            <form
              className="grid gap-2 md:grid-cols-[2fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const form = e.currentTarget;
                void act(async () => {
                  const { invitation } = await api<{ invitation: { link: string; emailed: boolean } }>("/api/org/invitations", {
                    body: { email: fd.get("email"), role: fd.get("role") },
                  });
                  setInviteLink(invitation.link);
                  form.reset();
                }, "Invitation created.");
              }}
            >
              <input name="email" type="email" className="input" placeholder="colleague@company.com" required aria-label="Email" />
              <select name="role" className="input" defaultValue="MEMBER" aria-label="Role">
                {ROLES.filter((r) => r.v !== "OWNER" || me.role === "OWNER").map((r) => (
                  <option key={r.v} value={r.v} title={r.desc}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary">Send invite</button>
            </form>
            {inviteLink && (
              <Notice tone="info">
                Share this one-time link with the invitee (also emailed when SMTP is configured). It expires in 7 days:
                <code className="mt-2 block break-all">{inviteLink}</code>
              </Notice>
            )}
            {team.invitations.length > 0 && (
              <ul className="space-y-2 text-sm">
                {team.invitations.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2">
                    <span>
                      {i.email} · {i.role.toLowerCase()} · expires {fmtDate(i.expiresAt)}
                    </span>
                    <button className="btn btn-ghost py-1" onClick={() => act(() => api(`/api/org/invitations/${i.id}`, { method: "DELETE" }), "Invitation revoked.")}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

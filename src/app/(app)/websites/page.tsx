import Link from "next/link";
import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { listWebsites } from "@/server/services/websites";
import { getEntitlement } from "@/server/billing/entitlements";
import { Empty, Notice, PageHeader, Section, StateIndicator, WebsiteStatusBadge } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { AddWebsiteForm } from "./add-website-form";

const PAUSE_REASON: Record<string, string> = {
  PLAN_LIMIT: "Over plan limit",
  SUBSCRIPTION_INACTIVE: "Subscription inactive",
  USER: "Paused by you",
};

export default async function WebsitesPage({ searchParams }: { searchParams: Promise<{ welcome?: string; onboarding?: string }> }) {
  const s = await requirePageSession("website.read");
  const [sites, sp, ent] = await Promise.all([listWebsites(s.org.id), searchParams, getEntitlement(s.org.id)]);
  const atLimit = sites.length >= ent.limits.websites;

  return (
    <div className="space-y-6">
      <PageHeader title="Websites" subtitle="Connect a website you own, verify control of the domain, and monitoring starts automatically." />
      {sp.onboarding && ent.active && (
        <Notice tone="success">
          Your {ent.plan?.name} subscription is active. Next: add your website and verify ownership. Monitoring starts automatically after
          verification.
        </Notice>
      )}
      {sp.welcome && (
        <Notice tone="success">
          Welcome to TrustifyX Secure360! Start by adding your website below. No JavaScript snippet is needed. Monitoring uses only
          external, non-intrusive checks.
        </Notice>
      )}
      {can(s.role, "website.create") &&
        (!ent.active ? (
          <Notice tone="warn">
            An active subscription is required to connect websites.{" "}
            <Link className="font-semibold underline" href="/billing">
              Choose a plan
            </Link>
          </Notice>
        ) : atLimit ? (
          <Notice>
            You are using {sites.length} of {ent.limits.websites} website{ent.limits.websites === 1 ? "" : "s"} on the {ent.plan?.name} plan.
            Remove a website or{" "}
            <Link className="font-semibold underline" href="/billing">
              upgrade
            </Link>{" "}
            to add more.
          </Notice>
        ) : (
          <Section title={`Add website (${sites.length} of ${ent.limits.websites} used)`}>
            <AddWebsiteForm />
          </Section>
        ))}
      <Section title={`Your websites (${sites.length})`}>
        {sites.length === 0 ? (
          <Empty>No websites yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Website</th>
                  <th>Status</th>
                  <th>State</th>
                  <th>Response</th>
                  <th>Last check</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sites.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <div className="font-medium">{w.displayName}</div>
                      <div className="text-xs text-ink-faint">{w.url}</div>
                    </td>
                    <td>
                      <WebsiteStatusBadge status={w.status} />
                      {w.status === "MONITORING_PAUSED" && w.pausedReason && <div className="mt-1 text-xs text-ink-faint">{PAUSE_REASON[w.pausedReason]}</div>}
                    </td>
                    <td><StateIndicator state={w.state} status={w.status} /></td>
                    <td className="tabular-nums">{w.lastResponseTimeMs !== null ? `${w.lastResponseTimeMs} ms` : "—"}</td>
                    <td className="text-ink-muted">{timeAgo(w.lastAvailabilityCheckAt)}</td>
                    <td className="text-right">
                      <Link href={`/websites/${w.id}`} className="btn btn-ghost py-1">
                        {w.status === "PENDING_VERIFICATION" || w.status === "VERIFICATION_FAILED" ? "Verify" : "Open"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

import Link from "next/link";
import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { prisma } from "@/server/db";
import { getEntitlement } from "@/server/billing/entitlements";
import { listUserOrgs } from "@/server/services/auth";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requirePageSession();
  const [orgs, ent, verified] = await Promise.all([
    listUserOrgs(s.user.id),
    getEntitlement(s.org.id),
    prisma.website.count({ where: { orgId: s.org.id, verifiedAt: { not: null } } }),
  ]);

  let banner: { tone: string; text: React.ReactNode } | null = null;
  if (!ent.active) {
    banner = {
      tone: "border-amber-400/40 bg-amber-400/10 text-amber-100",
      text: (
        <>
          <b>No active subscription.</b> Monitoring is paused until a plan is active.{" "}
          <Link className="font-semibold underline" href="/billing">View plans</Link>
        </>
      ),
    };
  } else if (ent.state === "GRACE") {
    banner = {
      tone: "border-amber-400/40 bg-amber-400/10 text-amber-100",
      text: (
        <>
          <b>Payment overdue.</b> Monitoring continues until {day(ent.accessUntil)}.{" "}
          <Link className="font-semibold underline" href="/billing">Resolve in Billing</Link>
        </>
      ),
    };
  } else if (verified === 0) {
    banner = {
      tone: "border-sky-400/40 bg-sky-500/10 text-sky-100",
      text: (
        <>
          <b>Subscription Active · Website Verification Required.</b> Add your website and verify ownership to start monitoring.{" "}
          <Link className="font-semibold underline" href="/websites">Connect website</Link>
        </>
      ),
    };
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar canAudit={can(s.role, "audit.read")} isPlatformAdmin={s.user.isPlatformAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={{ name: s.user.name, email: s.user.email }} org={s.org} role={s.role} orgs={orgs} />
        {banner && (
          <div role="status" className={`border-b px-4 py-2.5 text-sm md:px-8 ${banner.tone}`}>
            {banner.text}
          </div>
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

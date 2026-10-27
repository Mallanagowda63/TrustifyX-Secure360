import Link from "next/link";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { prisma } from "@/server/db";
import { accessStatus } from "@/server/services/portal";
import { listUserOrgs } from "@/server/services/auth";
import { marketingUrl } from "@/server/sites";
import { PortalSidebar } from "@/components/portal/PortalSidebar";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";
export const metadata = { title: "TrustifyX Secure360 · Security Portal", robots: { index: false, follow: false } };

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", weight: ["600", "700", "800"], display: "swap" });

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");

/** The customer security portal shell (served on PORTAL_URL). */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const s = await requirePageSession(undefined, { mfaExempt: true });
  const [orgs, access, verified] = await Promise.all([
    listUserOrgs(s.user.id),
    accessStatus(s.org.id),
    prisma.website.count({ where: { orgId: s.org.id, verifiedAt: { not: null } } }),
  ]);

  let banner: { tone: string; text: React.ReactNode } | null = null;
  if (access.state === "SUBSCRIPTION_REQUIRED") {
    banner = {
      tone: "border-red-500/30 bg-red-500/10 text-red-100",
      text: (
        <>
          <b>Subscription Required.</b> Websites cannot be connected or monitored without an active plan.{" "}
          <a className="font-semibold underline" href={marketingUrl("/#pricing")}>View Pricing Plans</a>
        </>
      ),
    };
  } else if (access.state === "PAYMENT_PENDING") {
    banner = {
      tone: "border-sky-400/30 bg-sky-500/10 text-sky-100",
      text: (
        <>
          <b>Payment Confirmation Pending.</b> Your plan activates as soon as Razorpay confirms the payment.{" "}
          <Link className="font-semibold underline" href="/billing">Billing Status</Link>
        </>
      ),
    };
  } else if (access.state === "GRACE") {
    banner = {
      tone: "border-amber-400/30 bg-amber-400/10 text-amber-100",
      text: (
        <>
          <b>Payment overdue.</b> Monitoring continues until {day(access.accessUntil)}.{" "}
          <a className="font-semibold underline" href="/sso/open?target=marketing&next=%2Faccount%2Fbilling">Update payment</a>
        </>
      ),
    };
  } else if (verified === 0) {
    banner = {
      tone: "border-teal-400/30 bg-teal-500/10 text-teal-100",
      text: (
        <>
          <b>Subscription Active · Website Verification Required.</b> Connect and verify your website to start monitoring.{" "}
          <Link className="font-semibold underline" href="/check">Check Your Website Security</Link>
        </>
      ),
    };
  }

  return (
    <div className={`${inter.variable} ${jakarta.variable} portal-font flex min-h-screen bg-[#050b1a]`}>
      <PortalSidebar canAudit={can(s.role, "audit.read")} isPlatformAdmin={s.user.isPlatformAdmin} />
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

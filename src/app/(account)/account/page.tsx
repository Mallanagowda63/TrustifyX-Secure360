import Link from "next/link";
import { redirect } from "next/navigation";
import { getPageSession } from "@/server/auth/page";
import { accessStatus } from "@/server/services/portal";
import { prisma } from "@/server/db";
import { Notice } from "@/components/ui";
import { RefreshPaymentStatus } from "./refresh-status";

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "—");

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ welcome?: string; paid?: string }> }) {
  const s = await getPageSession();
  if (!s?.org) redirect("/login?next=/account");
  const [a, sp, verified] = await Promise.all([
    accessStatus(s.org.id),
    searchParams,
    prisma.website.count({ where: { orgId: s.org.id, verifiedAt: { not: null } } }),
  ]);

  return (
    <div className="space-y-6">
      {sp.paid && a.active && <Notice tone="success">Payment confirmed. Your {a.planName} subscription is active.</Notice>}
      {sp.welcome && !a.active && a.state !== "PAYMENT_PENDING" && <Notice tone="info">Welcome to TrustifyX Secure360! Choose a plan to start monitoring your websites.</Notice>}

      <section className="card overflow-hidden">
        <div className="bg-[linear-gradient(135deg,rgba(37,99,235,0.25),rgba(20,184,166,0.15))] p-6 sm:p-8">
          <p className="text-sm font-medium tracking-wide text-sky-200 uppercase">Your subscription</p>
          <h1 className="mt-2 text-3xl font-semibold">{a.active ? `${a.planName} plan` : a.label}</h1>
          <p className="mt-2 text-ink-muted">
            {a.state === "ACTIVE" && `Active · websites used ${a.websitesUsed} of ${a.limits.websites}`}
            {a.state === "COMPLIMENTARY" && `Complimentary access until ${day(a.accessUntil)}`}
            {a.state === "CANCELLING" && `Cancelled · service continues until ${day(a.accessUntil)}`}
            {a.state === "GRACE" && `Your last payment failed. Monitoring continues until ${day(a.accessUntil)}.`}
            {a.state === "PAYMENT_PENDING" && "We are waiting for Razorpay to confirm your payment. This usually takes less than a minute."}
            {a.state === "SUBSCRIPTION_REQUIRED" && "You do not have an active subscription. Choose a plan to start monitoring."}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {a.active ? (
              <>
                <a href="/sso/open?target=portal&next=%2F" className="btn btn-primary px-5 py-3 text-base">Open Security Dashboard →</a>
                {verified === 0 && <a href="/sso/open?target=portal&next=%2Fcheck" className="btn btn-ghost px-5 py-3 text-base">+ Check Your Website Security</a>}
              </>
            ) : a.state === "PAYMENT_PENDING" ? (
              <RefreshPaymentStatus />
            ) : (
              <Link href="/#pricing" className="btn btn-primary px-5 py-3 text-base">View Pricing Plans</Link>
            )}
            <Link href="/account/billing" className="btn btn-ghost px-5 py-3 text-base">Manage billing</Link>
          </div>
        </div>
        {a.active && verified === 0 && (
          <div className="border-t border-navy-700 p-6 text-sm text-ink-muted">
            <b className="text-ink">Subscription Active · Website Verification Required.</b> Open the Security Portal, enter your website address and verify
            ownership (DNS TXT record or verification file). Monitoring starts automatically after verification.
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["1. Open the Security Portal", "Your cybersecurity command center at a separate, private address. You are signed in automatically from here."],
          ["2. Check Your Website Security", "Enter your HTTPS website address and prove you control the domain."],
          ["3. Monitoring starts", "Availability, SSL/TLS, security headers and DNS are checked automatically. Results appear in your dashboard."],
        ].map(([t, d]) => (
          <div key={t} className="card p-5">
            <h2 className="font-semibold">{t}</h2>
            <p className="mt-2 text-sm text-ink-muted">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

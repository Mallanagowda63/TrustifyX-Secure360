import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { accessStatus } from "@/server/services/portal";
import { billingOverview } from "@/server/billing/service";
import { marketingUrl } from "@/server/sites";
import { Notice, PageHeader, Section } from "@/components/ui";

const day = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: (p / 100) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const TONE: Record<string, "success" | "warn" | "error" | "info"> = {
  ACTIVE: "success",
  COMPLIMENTARY: "info",
  CANCELLING: "warn",
  GRACE: "warn",
  PAYMENT_PENDING: "info",
  SUBSCRIPTION_REQUIRED: "error",
};

/** Portal: read-only subscription status. Purchases and changes happen on the main website. */
export default async function BillingStatusPage() {
  const s = await requirePageSession("billing.read");
  const [a, o] = await Promise.all([accessStatus(s.org.id), billingOverview(s.org.id)]);
  const manage = can(s.role, "billing.manage");
  return (
    <div className="space-y-6">
      <PageHeader title="Billing Status" subtitle="Your subscription is managed on the TrustifyX Secure360 website." />
      <Notice tone={TONE[a.state]}>
        <b>{a.label}</b>
        {a.state === "PAYMENT_PENDING" && " · we are waiting for Razorpay to confirm your payment; monitoring starts once it is confirmed."}
        {a.state === "SUBSCRIPTION_REQUIRED" && " · choose a plan on the TrustifyX Secure360 website to connect and monitor websites."}
      </Notice>
      <Section title="Subscription">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 text-sm md:grid-cols-4">
          <div><dt className="text-ink-faint">Plan</dt><dd className="text-lg font-semibold">{a.planName ?? "—"}</dd></div>
          <div><dt className="text-ink-faint">Websites</dt><dd className="text-lg font-semibold">{a.websitesUsed} / {a.limits.websites || "—"}</dd></div>
          <div><dt className="text-ink-faint">{o.subscription?.nextBillingDate ? "Next billing date" : "Service until"}</dt><dd className="text-lg font-semibold">{day(o.subscription?.nextBillingDate ?? a.accessUntil)}</dd></div>
          <div><dt className="text-ink-faint">Price</dt><dd className="text-lg font-semibold">{o.subscription ? (o.subscription.mode === "COMPLIMENTARY" ? "Complimentary" : `${inr(o.subscription.amountPaise)}/${o.subscription.cycle === "ANNUAL" ? "yr" : "mo"}`) : "—"}</dd></div>
        </dl>
        <div className="mt-6 flex flex-wrap gap-2 border-t border-navy-700 pt-5">
          {a.active ? (
            manage && <a className="btn btn-primary" href="/sso/open?target=marketing&next=%2Faccount%2Fbilling">Manage subscription</a>
          ) : (
            <a className="btn btn-primary" href={marketingUrl("/#pricing")}>View Pricing Plans</a>
          )}
          {o.invoices.length > 0 && <a className="btn btn-ghost" href={`/api/billing/invoices/${o.invoices[0].id}/pdf`}>Latest invoice (PDF)</a>}
        </div>
      </Section>
    </div>
  );
}

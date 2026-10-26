import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { billingOverview } from "@/server/billing/service";
import { PageHeader } from "@/components/ui";
import { BillingView } from "./billing-view";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const s = await requirePageSession("billing.read");
  const [overview, sp] = await Promise.all([billingOverview(s.org.id), searchParams]);
  return (
    <div>
      <PageHeader title="Billing" subtitle="Your plan, payments and invoices. Payments are processed securely by Razorpay." />
      <BillingView initial={JSON.parse(JSON.stringify(overview))} canManage={can(s.role, "billing.manage")} welcome={Boolean(sp.welcome)} />
    </div>
  );
}

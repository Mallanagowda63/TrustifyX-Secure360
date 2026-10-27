import { redirect } from "next/navigation";
import { getPageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { billingOverview } from "@/server/billing/service";
import { BillingView } from "@/components/billing/BillingView";
import { Notice, PageHeader } from "@/components/ui";

export default async function AccountBillingPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const s = await getPageSession();
  if (!s?.org || !s.role) redirect("/login?next=/account/billing");
  const [overview, sp] = await Promise.all([billingOverview(s.org.id), searchParams]);
  return (
    <div>
      <PageHeader title="Subscription & billing" subtitle="Plans, payments and invoices. Payments are processed securely by Razorpay." />
      {!can(s.role, "billing.read") ? (
        <Notice>Your role cannot view billing.</Notice>
      ) : (
        <BillingView initial={JSON.parse(JSON.stringify(overview))} canManage={can(s.role, "billing.manage")} welcome={Boolean(sp.welcome)} />
      )}
    </div>
  );
}

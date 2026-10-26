import { redirect } from "next/navigation";
import { requirePageSession } from "@/server/auth/page";
import { adminBillingOverview } from "@/server/billing/admin";
import { PageHeader } from "@/components/ui";
import { AdminView } from "./admin-view";

export default async function AdminPage() {
  const s = await requirePageSession();
  if (!s.user.isPlatformAdmin) redirect("/dashboard");
  const data = await adminBillingOverview();
  return (
    <div>
      <PageHeader
        title="Platform admin · Billing"
        subtitle="TrustifyX operator view. Paid status only ever comes from Razorpay. This console cannot mark payments as paid."
      />
      <AdminView initial={JSON.parse(JSON.stringify(data))} />
    </div>
  );
}

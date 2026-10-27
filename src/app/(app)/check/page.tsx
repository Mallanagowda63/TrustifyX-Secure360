import Link from "next/link";
import { requirePageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { accessStatus } from "@/server/services/portal";
import { getWebsiteForOrg, listWebsites, presentWebsite } from "@/server/services/websites";
import { marketingUrl } from "@/server/sites";
import { CheckWebsiteSecurity } from "@/components/portal/CheckWebsiteSecurity";
import { Notice, PageHeader } from "@/components/ui";

export default async function CheckPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const s = await requirePageSession("website.read");
  const [access, sites, sp] = await Promise.all([accessStatus(s.org.id), listWebsites(s.org.id), searchParams]);
  const resume = sp.site ? await getWebsiteForOrg(s.org.id, sp.site).then(presentWebsite).catch(() => null) : null;
  const pending = sites.filter((w) => w.status === "PENDING_VERIFICATION" || w.status === "VERIFICATION_FAILED");

  return (
    <div className="space-y-6">
      <PageHeader title="Check Website Security" subtitle="Connect a website you own. Monitoring starts automatically after ownership is verified." />
      {!access.active ? (
        <div className="rounded-2xl border border-white/10 bg-[#0a1428] p-8 text-center">
          <h2 className="font-display text-2xl font-bold text-white">{access.label}</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">
            {access.state === "PAYMENT_PENDING"
              ? "We are waiting for Razorpay to confirm your payment. You can connect your website as soon as it is confirmed."
              : "An active TrustifyX Secure360 plan is required to connect and monitor websites. Plans are purchased on the TrustifyX Secure360 website."}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            {access.state === "PAYMENT_PENDING" ? (
              <Link className="portal-btn-primary" href="/billing">Billing Status</Link>
            ) : (
              <a className="portal-btn-primary" href={marketingUrl("/#pricing")}>View Pricing Plans</a>
            )}
          </div>
        </div>
      ) : access.websitesUsed >= access.limits.websites && !resume ? (
        <Notice>
          Your {access.planName} plan includes {access.limits.websites} website{access.limits.websites === 1 ? "" : "s"} and all are in use.{" "}
          <a className="font-semibold underline" href="/sso/open?target=marketing&next=%2Faccount%2Fbilling">Upgrade your plan</a> or remove a website to add another.
        </Notice>
      ) : (
        <CheckWebsiteSecurity key={resume?.id ?? "new"} plansUrl={marketingUrl("/#pricing")} resume={JSON.parse(JSON.stringify(resume))} canCreate={can(s.role, "website.create")} />
      )}

      {pending.length > 0 && !resume && (
        <section className="rounded-xl border border-white/10 bg-[#0a1428] p-5">
          <h2 className="font-semibold text-white">Waiting for verification</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {pending.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3">
                <span className="text-slate-300">{w.hostname}</span>
                <Link className="btn btn-ghost py-1" href={`/check?site=${w.id}`}>Continue verification</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

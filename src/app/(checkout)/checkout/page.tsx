import Link from "next/link";
import { redirect } from "next/navigation";
import { getPageSession } from "@/server/auth/page";
import { can } from "@/server/auth/rbac";
import { addonEntitlement, getEntitlement } from "@/server/billing/entitlements";
import { gatewayAvailable, isTestMode } from "@/server/billing/gateway";
import { annualEnabled, formatInr, getPlanByCode, planRank, priceFor } from "@/server/billing/plans";
import { env } from "@/server/env";
import { Logo } from "@/components/Logo";
import { Notice } from "@/components/ui";
import { PayButton } from "./pay-button";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ plan?: string; addon?: string; cycle?: string }> }) {
  const sp = await searchParams;
  const isAddon = Boolean(sp.addon);
  const code = (sp.addon ?? sp.plan ?? "").toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 40);
  const cycle = sp.cycle === "ANNUAL" ? "ANNUAL" : "MONTHLY";
  const session = await getPageSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/checkout?${isAddon ? "addon" : "plan"}=${code}&cycle=${cycle}`)}`);
  if (!session.org || !session.role) redirect("/login?error=no_org");

  const plan = code ? await getPlanByCode(code) : null;
  if (!plan || !plan.active || (plan.kind === "ADDON") !== isAddon) redirect("/#pricing");
  const useCycle = cycle === "ANNUAL" && annualEnabled(plan) ? "ANNUAL" : "MONTHLY";
  const price = priceFor(plan, useCycle);
  const ent = await getEntitlement(session.org.id);
  const addonState = isAddon ? await addonEntitlement(session.org.id, plan.code) : null;
  const current = !isAddon && ent.active && ent.subscription && ent.subscription.mode !== "COMPLIMENTARY" && ent.state !== "GRACE" ? ent.subscription : null;
  const samePlan = isAddon ? Boolean(addonState?.active) : current && current.planId === plan.id && current.cycle === useCycle;
  const isUpgrade = current ? planRank(plan) >= planRank(current.plan) : false;
  const canManage = can(session.role, "billing.manage");
  const e = env();
  const recurring = e.BILLING_MODE !== "prepaid";

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,#14223f_0%,#060d1f_60%)] px-4 py-10">
      <div className="mx-auto max-w-4xl">
        <Link href="/" className="inline-flex items-center gap-2 text-lg font-semibold">
          <Logo /> TrustifyX <span className="text-brand">Secure360</span>
        </Link>
        <h1 className="mt-8 text-2xl font-semibold">Review and pay</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Signed in as {session.user.email} · organization <b className="text-ink">{session.org.name}</b>
        </p>

        <div className="mt-6 grid gap-6 md:grid-cols-[1.4fr_1fr]">
          <section className="card p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">{plan.name}{isAddon ? " (add-on)" : " plan"}</h2>
                <p className="text-sm text-ink-muted">{plan.tagline}</p>
              </div>
              <span className="rounded-md border border-navy-600 px-2 py-0.5 text-xs text-ink-muted">{useCycle === "ANNUAL" ? "Billed yearly" : "Billed monthly"}</span>
            </div>
            <ul className="mt-5 space-y-2 text-sm text-ink-muted">
              {(plan.features as string[]).map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-teal-400" aria-hidden>✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <div className="mt-6 rounded-lg border border-navy-700 bg-navy-900 p-4 text-sm">
              <div className="font-medium text-ink">What happens next</div>
              {isAddon ? (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-muted">
                  <li>Pay securely in the Razorpay window.</li>
                  <li>Our server verifies the payment with Razorpay before enabling the add-on.</li>
                  <li>Connect your own Cloudflare account in the portal (Firewall &amp; Protection).</li>
                  <li>Review each protection change before it is applied.</li>
                </ol>
              ) : (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-muted">
                  <li>Pay securely in the Razorpay window.</li>
                  <li>Our server verifies the payment with Razorpay before activating your plan.</li>
                  <li>Add your website and verify ownership (DNS TXT or verification file).</li>
                  <li>Monitoring starts automatically after verification.</li>
                </ol>
              )}
              {isAddon && (
                <p className="mt-3 text-xs text-ink-faint">
                  This add-on does not include a paid Cloudflare plan. Cloudflare features beyond your Cloudflare plan are unavailable until you upgrade with
                  Cloudflare, who bill you directly. 24/7 incident response or managed SOC services are not included.
                </p>
              )}
            </div>
          </section>

          <aside className="card h-fit p-6">
            <h2 className="text-sm font-semibold tracking-wide text-ink-muted uppercase">Order summary</h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-ink-muted">{plan.name} ({useCycle === "ANNUAL" ? "12 months" : "1 month"})</dt><dd>{formatInr(price.subtotalPaise)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">GST ({price.taxRateBp / 100}%)</dt><dd>{formatInr(price.taxPaise)}</dd></div>
              <div className="flex justify-between border-t border-navy-700 pt-2 text-base font-semibold"><dt>Total today</dt><dd>{formatInr(price.totalPaise)}</dd></div>
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              {recurring
                ? `Renews automatically every ${useCycle === "ANNUAL" ? "year" : "month"} at ${formatInr(price.totalPaise)} until you cancel.`
                : `Prepaid: does not renew automatically. You will be reminded before it ends.`}{" "}
              The amount is set by our server; it cannot be changed in the browser.
            </p>

            <div className="mt-5 space-y-3">
              {!gatewayAvailable() ? (
                <Notice tone="warn">Online payments are not enabled on this server yet. Please contact {e.SUPPORT_EMAIL}.</Notice>
              ) : isAddon && !ent.active ? (
                <Notice tone="warn">Add-ons require an active Starter, Growth or Business plan. <Link className="underline" href="/#pricing">Choose a plan</Link></Notice>
              ) : !canManage ? (
                <Notice>Only organization owners and admins can purchase or change plans.</Notice>
              ) : samePlan ? (
                <Notice tone="success">
                  You already have {isAddon ? "this add-on" : "this plan"}. <Link className="underline" href="/account/billing">Manage billing</Link>
                </Notice>
              ) : (
                <>
                  {current && (
                    <Notice tone="info">
                      {isUpgrade
                        ? `Upgrading from ${current.plan.name}: the new plan starts once this payment is confirmed, and your ${current.plan.name} subscription ends then (no pro-rata credit).`
                        : `Downgrading from ${current.plan.name}: the new plan starts when your current period ends${current.currentPeriodEnd ? ` (${current.currentPeriodEnd.toUTCString().slice(0, 16)})` : ""}. Websites above the new limit will be paused, not deleted.`}
                    </Notice>
                  )}
                  {isTestMode() && <Notice tone="warn">Razorpay test mode: use Razorpay test cards/UPI. No real money is charged.</Notice>}
                  <PayButton planCode={plan.code} cycle={useCycle} change={Boolean(current)} addon={isAddon} totalLabel={formatInr(price.totalPaise)} />
                </>
              )}
            </div>
            <p className="mt-4 text-center text-xs text-ink-faint">
              By paying you agree to the <Link className="underline" href="/legal/terms">Terms</Link> and{" "}
              <Link className="underline" href="/legal/refunds">Refund &amp; Cancellation Policy</Link>.
            </p>
          </aside>
        </div>
      </div>
    </div>
  );
}

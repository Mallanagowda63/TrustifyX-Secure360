"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Empty, Notice, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { runCheckout, waitForActivation, type CheckoutPayload } from "@/components/razorpay";

interface Price {
  subtotalPaise: number;
  taxPaise: number;
  totalPaise: number;
  taxRateBp: number;
}
interface Plan {
  code: string;
  name: string;
  tagline: string;
  highlight: boolean;
  limits: { websites: number; members: number; aiAssistant: boolean; auditLogs: boolean; scheduledReports: boolean };
  monthly: Price;
  annual: Price | null;
}
interface Overview {
  entitlement: { active: boolean; state: string; accessUntil: string | null; limits: { websites: number; members: number }; plan: { code: string; name: string } | null };
  subscription: {
    planCode: string;
    planName: string;
    cycle: "MONTHLY" | "ANNUAL";
    mode: "RECURRING" | "PREPAID" | "COMPLIMENTARY";
    status: string;
    amountPaise: number;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    graceUntil: string | null;
    cancelAtPeriodEnd: boolean;
    nextBillingDate: string | null;
    autoRenews: boolean;
    grantReason: string | null;
  } | null;
  pending: { planName: string; cycle: string; scheduledStartAt: string | null; createdAt: string; replaces: boolean } | null;
  history: Array<{ id: string; plan: string; cycle: string; mode: string; status: string; start: string | null; end: string | null; createdAt: string }>;
  usage: { websites: number; connectedWebsites: number; members: number };
  payments: Array<{ id: string; razorpayPaymentId: string; amountPaise: number; status: string; method: string | null; errorDescription: string | null; refundedPaise: number; createdAt: string }>;
  invoices: Array<{ id: string; number: string; totalPaise: number; taxPaise: number; status: string; issuedAt: string; periodStart: string | null; periodEnd: string | null }>;
  plans: Plan[];
  config: { mode: "RECURRING" | "PREPAID"; configured: boolean; testMode: boolean; annualEnabled: boolean; graceDays: number };
}

const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: (p / 100) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const day = (d: string | null) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: "Active", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-200" },
  GRACE: { label: "Payment overdue · grace period", cls: "border-amber-400/50 bg-amber-400/10 text-amber-200" },
  CANCELLING: { label: "Cancels at period end", cls: "border-slate-400/50 bg-slate-400/10 text-slate-200" },
  COMPLIMENTARY: { label: "Complimentary access", cls: "border-sky-400/50 bg-sky-400/10 text-sky-200" },
  NONE: { label: "No active subscription", cls: "border-red-500/50 bg-red-500/10 text-red-200" },
};

export function BillingView({ initial, canManage, welcome }: { initial: Overview; canManage: boolean; welcome: boolean }) {
  const router = useRouter();
  const [o, setO] = useState<Overview>(initial);
  const [cycle, setCycle] = useState<"MONTHLY" | "ANNUAL">(initial.subscription?.cycle === "ANNUAL" ? "ANNUAL" : "MONTHLY");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "info" | "warn"; text: string } | null>(null);
  const [showPlans, setShowPlans] = useState(!initial.entitlement.active);

  const sub = o.subscription;
  const state = STATE_LABEL[o.entitlement.state] ?? STATE_LABEL.NONE;

  async function act(label: string, fn: () => Promise<Overview | void>, success?: string) {
    setBusy(label);
    setMsg(null);
    try {
      const next = await fn();
      if (next) setO(next);
      if (success) setMsg({ tone: "success", text: success });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function renew() {
    await act("renew", async () => {
      const { checkout } = await api<{ checkout: CheckoutPayload }>("/api/billing/renew", { method: "POST" });
      const r = await runCheckout(checkout);
      if (r.status === "failed") throw new Error(r.message);
      if (r.status === "dismissed") return;
      setMsg({ tone: "info", text: "Payment received; waiting for confirmation…" });
      await waitForActivation();
      return api<Overview>("/api/billing/overview");
    });
  }

  return (
    <div className="space-y-6">
      {welcome && !o.entitlement.active && <Notice tone="success">Welcome to TrustifyX Secure360! Choose a plan to start monitoring your website.</Notice>}
      {!o.config.configured && <Notice tone="warn">Online payments are not configured on this server yet (Razorpay keys missing). Plans can be viewed but not purchased.</Notice>}
      {o.config.testMode && <Notice tone="warn">Razorpay is in TEST MODE. Payments use test cards/UPI and no real money is charged.</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Section
        title="Current plan"
        actions={
          canManage && o.config.configured ? (
            <button className="btn btn-ghost py-1" disabled={busy !== null} onClick={() => act("sync", () => api<Overview>("/api/billing/sync", { method: "POST" }), "Billing status refreshed from Razorpay.")}>
              ↻ Refresh status
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold">{o.entitlement.plan?.name ?? "No plan"}</span>
              <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${state.cls}`}>{state.label}</span>
            </div>
            {sub && (
              <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-ink-faint">Price</dt>
                  <dd>{sub.mode === "COMPLIMENTARY" ? "Complimentary" : `${inr(sub.amountPaise)} / ${sub.cycle === "ANNUAL" ? "year" : "month"} incl. GST`}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Billing</dt>
                  <dd>{sub.mode === "RECURRING" ? (sub.autoRenews ? "Auto-renews via Razorpay" : "Auto-renew off") : sub.mode === "PREPAID" ? "Prepaid, manual renewal" : "Granted by TrustifyX"}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">{sub.nextBillingDate ? "Next billing date" : "Service until"}</dt>
                  <dd>{day(sub.nextBillingDate ?? o.entitlement.accessUntil)}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Current period</dt>
                  <dd>
                    {day(sub.currentPeriodStart)} – {day(sub.currentPeriodEnd)}
                  </dd>
                </div>
              </dl>
            )}
            {sub?.grantReason && <p className="mt-2 text-xs text-ink-faint">Reason: {sub.grantReason}</p>}
          </div>
          <div className="min-w-56 rounded-lg border border-navy-700 bg-navy-900 p-4 text-sm">
            <div className="text-ink-faint">Websites</div>
            <div className="text-lg font-semibold">
              {o.usage.websites} / {o.entitlement.limits.websites || "—"}
            </div>
            <div className="mt-1 text-xs text-ink-faint">{o.usage.connectedWebsites} monitored</div>
            <div className="mt-3 text-ink-faint">Team members</div>
            <div className="font-semibold">
              {o.usage.members} / {o.entitlement.limits.members}
            </div>
          </div>
        </div>

        {o.entitlement.state === "GRACE" && sub?.graceUntil && (
          <div className="mt-4">
            <Notice tone="warn">
              The last renewal payment failed. Monitoring continues until {day(sub.graceUntil)}. {sub.mode === "PREPAID" ? "Renew now to avoid interruption." : "Razorpay retries automatically; you can also update your payment method by renewing."}
            </Notice>
          </div>
        )}
        {o.entitlement.active && o.usage.connectedWebsites === 0 && (
          <div className="mt-4">
            <Notice tone="info">
              <b>Subscription Active · Website Verification Required.</b> <Link className="underline" href="/websites">Add and verify your website</Link> to start monitoring.
            </Notice>
          </div>
        )}
        {o.pending && (
          <div className="mt-4">
            <Notice tone="info">
              {o.pending.scheduledStartAt
                ? `Your change to ${o.pending.planName} is scheduled to start on ${day(o.pending.scheduledStartAt)}.`
                : `A checkout for ${o.pending.planName} was started on ${day(o.pending.createdAt)} and is awaiting payment confirmation. If you paid, use “Refresh status”.`}
            </Notice>
          </div>
        )}

        {canManage && (
          <div className="mt-6 flex flex-wrap gap-2 border-t border-navy-700 pt-5">
            <button className="btn btn-primary" onClick={() => setShowPlans((s) => !s)}>
              {o.entitlement.active ? "Change plan" : "Choose a plan"}
            </button>
            {sub && (sub.mode === "PREPAID" || o.entitlement.state === "GRACE" || !o.entitlement.active) && sub.mode !== "COMPLIMENTARY" && o.config.configured && (
              <button className="btn btn-ghost" disabled={busy !== null} onClick={renew}>
                Renew subscription
              </button>
            )}
            {sub && o.entitlement.active && sub.mode !== "COMPLIMENTARY" && !sub.cancelAtPeriodEnd && (
              <>
                <button
                  className="btn btn-ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!confirm(`Cancel at the end of the current period (${day(sub.currentPeriodEnd)})? Monitoring continues until then.`)) return;
                    void act("cancel", () => api<Overview>("/api/billing/cancel", { body: { atPeriodEnd: true } }), "Your subscription will end at the close of the current period.");
                  }}
                >
                  Cancel at period end
                </button>
                <button
                  className="btn btn-danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!confirm("Cancel immediately? Monitoring pauses now and the unused part of the period is not refunded. Your data is kept.")) return;
                    void act("cancel-now", () => api<Overview>("/api/billing/cancel", { body: { atPeriodEnd: false } }), "Subscription cancelled. Monitoring is paused; your data is kept.");
                  }}
                >
                  Cancel now
                </button>
              </>
            )}
          </div>
        )}
      </Section>

      {showPlans && canManage && (
        <Section
          title={o.entitlement.active ? "Change plan" : "Choose a plan"}
          actions={
            o.config.annualEnabled ? (
              <div className="flex gap-1" role="radiogroup" aria-label="Billing period">
                {(["MONTHLY", "ANNUAL"] as const).map((c) => (
                  <button key={c} role="radio" aria-checked={cycle === c} className={`btn py-1 ${cycle === c ? "btn-primary" : "btn-ghost"}`} onClick={() => setCycle(c)}>
                    {c === "MONTHLY" ? "Monthly" : "Annual"}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            {o.plans.map((p) => {
              const price = cycle === "ANNUAL" && p.annual ? p.annual : p.monthly;
              const current = sub?.planCode === p.code && sub.cycle === cycle && sub.mode !== "COMPLIMENTARY" && o.entitlement.active;
              return (
                <div key={p.code} className={`rounded-xl border p-5 ${p.highlight ? "border-brand" : "border-navy-700"}`}>
                  <div className="text-lg font-semibold">{p.name}</div>
                  <div className="text-xs text-ink-muted">{p.tagline}</div>
                  <div className="mt-3 text-2xl font-semibold">
                    {inr(price.subtotalPaise)}
                    <span className="text-sm font-normal text-ink-muted">/{cycle === "ANNUAL" ? "yr" : "mo"} + GST</span>
                  </div>
                  <div className="text-xs text-ink-faint">{inr(price.totalPaise)} incl. {price.taxRateBp / 100}% GST</div>
                  <ul className="mt-3 space-y-1 text-xs text-ink-muted">
                    <li>{p.limits.websites} website{p.limits.websites > 1 ? "s" : ""} · {p.limits.members} member{p.limits.members > 1 ? "s" : ""}</li>
                    <li>{p.limits.aiAssistant ? "✓ AI explanations" : "— No AI explanations"}</li>
                    <li>{p.limits.scheduledReports ? "✓ Scheduled email reports" : "— Download reports only"}</li>
                    <li>{p.limits.auditLogs ? "✓ Audit logs" : "— No audit logs"}</li>
                  </ul>
                  {p.limits.websites < o.usage.websites && o.entitlement.active && (
                    <p className="mt-2 text-xs text-amber-200">You have {o.usage.websites} websites; {o.usage.websites - p.limits.websites} would be paused (not deleted).</p>
                  )}
                  {current ? (
                    <div className="btn btn-ghost mt-4 w-full cursor-default">Current plan</div>
                  ) : (
                    <Link className={`btn mt-4 w-full ${p.highlight ? "btn-primary" : "btn-ghost"}`} href={`/checkout?plan=${p.code}&cycle=${cycle}`}>
                      {o.entitlement.active ? `Switch to ${p.name}` : `Choose ${p.name}`}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Invoices & receipts">
          {o.invoices.length === 0 ? (
            <Empty>No invoices yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Date</th>
                    <th>Total</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {o.invoices.map((i) => (
                    <tr key={i.id}>
                      <td className="mono text-xs">{i.number}</td>
                      <td className="whitespace-nowrap">{day(i.issuedAt)}</td>
                      <td>{inr(i.totalPaise)}</td>
                      <td>{i.status === "VOID" ? "Refunded" : "Paid"}</td>
                      <td className="text-right">
                        <a className="btn btn-ghost py-1" href={`/api/billing/invoices/${i.id}/pdf`}>
                          PDF
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="Payment history">
          {o.payments.length === 0 ? (
            <Empty>No payments yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Method</th>
                  </tr>
                </thead>
                <tbody>
                  {o.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                      <td>{inr(p.amountPaise)}</td>
                      <td>
                        <span className={p.status === "CAPTURED" ? "text-emerald-300" : p.status === "FAILED" ? "text-red-300" : "text-ink-muted"}>
                          {p.status.replace("_", " ").toLowerCase()}
                        </span>
                        {p.errorDescription && <div className="text-xs text-ink-faint">{p.errorDescription}</div>}
                        {p.refundedPaise > 0 && <div className="text-xs text-ink-faint">Refunded {inr(p.refundedPaise)}</div>}
                      </td>
                      <td className="text-ink-muted">{p.method ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      {o.history.length > 0 && (
        <Section title="Subscription history">
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Billing</th>
                  <th>Status</th>
                  <th>Period</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {o.history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.plan}</td>
                    <td className="text-ink-muted">{h.mode.toLowerCase()} · {h.cycle.toLowerCase()}</td>
                    <td>{h.status.replace("_", " ").toLowerCase()}</td>
                    <td className="text-ink-muted">
                      {day(h.start)} – {day(h.end)}
                    </td>
                    <td className="text-ink-muted">{day(h.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <p className="text-xs text-ink-faint">
        Questions about billing? See the <Link className="underline" href="/legal/refunds">Refund &amp; Cancellation Policy</Link>. Grace period after a failed payment: {o.config.graceDays} days.
      </p>
    </div>
  );
}

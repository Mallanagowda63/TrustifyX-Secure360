"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Empty, Notice, Section } from "@/components/ui";
import { fmtDate } from "@/lib/format";

interface Plan {
  code: string;
  name: string;
  tagline: string;
  description: string;
  monthlyPricePaise: number;
  annualPricePaise: number | null;
  maxWebsites: number;
  maxMembers: number;
  features: string[];
  highlight: boolean;
  active: boolean;
  aiAssistant: boolean;
  scheduledReports: boolean;
  auditLogs: boolean;
}
interface Data {
  counts: Record<string, number>;
  subscriptions: Array<{ id: string; org: { id: string; name: string }; plan: { code: string; name: string }; cycle: string; mode: string; status: string; amountPaise: number; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; grantReason: string | null; razorpaySubscriptionId: string | null; websites: number; monitored: number }>;
  failedPayments: Array<{ id: string; razorpayPaymentId: string; amountPaise: number; errorDescription: string | null; createdAt: string; org: { name: string } }>;
  recentPayments: Array<{ id: string; razorpayPaymentId: string; amountPaise: number; status: string; createdAt: string; org: { name: string } }>;
  webhookFailures: Array<{ id: string; eventId: string; eventType: string; status: string; attempts: number; error: string | null; receivedAt: string }>;
  awaitingVerification: Array<{ id: string; name: string; createdAt: string; _count: { websites: number } }>;
  auditLog: Array<{ id: string; action: string; actorType: string; orgId: string | null; details: unknown; createdAt: string }>;
  plans: Plan[];
  organizations: Array<{ id: string; name: string }>;
}

const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;

export function AdminView({ initial }: { initial: Data }) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [msg, setMsg] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setD(await api<Data>("/api/admin/billing"));
      setMsg({ tone: "success", text: success });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        {Object.entries(d.counts).map(([k, v]) => (
          <span key={k} className="rounded-md border border-navy-600 px-2.5 py-1 text-xs">
            {k.replace("_", " ").toLowerCase()}: <b>{v}</b>
          </span>
        ))}
        <button className="btn btn-primary ml-auto" disabled={busy} onClick={() => act(() => api("/api/admin/billing/reconcile", { method: "POST" }), "Reconciliation completed.")}>
          ↻ Run reconciliation
        </button>
      </div>

      <Section title={`Subscriptions (${d.subscriptions.length})`}>
        {d.subscriptions.length === 0 ? (
          <Empty>No subscriptions yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Period end</th>
                  <th>Usage</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.org.name}</td>
                    <td>{s.plan.name} · {s.cycle.toLowerCase()}</td>
                    <td className="text-xs">{s.mode.toLowerCase()}{s.grantReason ? ` (${s.grantReason})` : ""}</td>
                    <td className="text-xs">{s.status.toLowerCase()}{s.cancelAtPeriodEnd ? " · cancelling" : ""}</td>
                    <td>{s.mode === "COMPLIMENTARY" ? "—" : inr(s.amountPaise)}</td>
                    <td className="whitespace-nowrap text-xs">{s.currentPeriodEnd ? fmtDate(s.currentPeriodEnd) : "—"}</td>
                    <td className="text-xs">{s.monitored}/{s.websites} monitored</td>
                    <td>
                      {s.mode === "COMPLIMENTARY" && s.status === "ACTIVE" && (
                        <button className="btn btn-danger py-1 text-xs" disabled={busy} onClick={() => confirm(`Revoke complimentary access for ${s.org.name}?`) && act(() => api("/api/admin/billing/revoke", { body: { subscriptionId: s.id } }), "Grant revoked.")}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Payment failures">
          {d.failedPayments.length === 0 ? (
            <Empty>No failed payments.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.failedPayments.map((p) => (
                <li key={p.id} className="flex justify-between gap-3">
                  <span>{p.org.name} · {inr(p.amountPaise)} · <span className="text-ink-faint">{p.errorDescription}</span></span>
                  <span className="text-xs text-ink-faint">{fmtDate(p.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Webhook processing failures">
          {d.webhookFailures.length === 0 ? (
            <Empty>No unprocessed or failed webhook events.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.webhookFailures.map((w) => (
                <li key={w.id} className="flex items-start justify-between gap-3">
                  <div>
                    <div className="mono text-xs">{w.eventType} · {w.eventId}</div>
                    <div className="text-xs text-ink-faint">{w.status} · {w.attempts} attempts · {w.error}</div>
                  </div>
                  <button className="btn btn-ghost py-1 text-xs" disabled={busy} onClick={() => act(() => api(`/api/admin/billing/webhooks/${w.id}`, { method: "POST" }), "Event reprocessed.")}>
                    Reprocess
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Paid, awaiting domain verification">
          {d.awaitingVerification.length === 0 ? (
            <Empty>Every paying organization has a verified website.</Empty>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.awaitingVerification.map((o) => (
                <li key={o.id} className="flex justify-between">
                  <span>{o.name}</span>
                  <span className="text-xs text-ink-faint">{o._count.websites} website(s) added, none verified</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Grant complimentary access">
          <form
            className="space-y-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void act(
                () => api("/api/admin/billing/grant", { body: { orgId: fd.get("orgId"), planCode: fd.get("planCode"), days: Number(fd.get("days")), reason: fd.get("reason") } }),
                "Complimentary access granted (no payment record created).",
              );
            }}
          >
            <select name="orgId" className="input" required aria-label="Organization">
              {d.organizations.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <select name="planCode" className="input" aria-label="Plan">
                {d.plans.map((p) => (
                  <option key={p.code} value={p.code}>{p.name}</option>
                ))}
              </select>
              <input name="days" type="number" min={1} max={366} defaultValue={30} className="input w-28" aria-label="Days" />
            </div>
            <input name="reason" className="input" required minLength={3} placeholder="Reason (e.g. pilot customer, internal site)" />
            <button className="btn btn-primary" disabled={busy}>Grant</button>
          </form>
        </Section>
      </div>

      <Section title="Plan catalog (affects new checkouts only)">
        <div className="grid gap-4 lg:grid-cols-3">
          {d.plans.map((p) => (
            <PlanEditor key={p.code} plan={p} busy={busy} onSave={(patch, confirmCode) => act(() => api(`/api/admin/plans/${p.code}`, { method: "PATCH", body: { patch, confirmCode } }), `${p.name} plan updated.`)} />
          ))}
        </div>
      </Section>

      <Section title="Billing audit log (latest 100)">
        <div className="max-h-96 overflow-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {d.auditLog.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap text-xs">{fmtDate(a.createdAt)}</td>
                  <td className="text-xs">{a.actorType}</td>
                  <td className="mono text-xs">{a.action}</td>
                  <td className="max-w-md truncate text-xs text-ink-faint" title={JSON.stringify(a.details)}>{a.details ? JSON.stringify(a.details) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function PlanEditor({ plan, busy, onSave }: { plan: Plan; busy: boolean; onSave: (patch: Record<string, unknown>, confirmCode: string) => void }) {
  return (
    <form
      className="space-y-2 rounded-lg border border-navy-700 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const annual = String(fd.get("annual") ?? "").trim();
        onSave(
          {
            name: String(fd.get("name")),
            tagline: String(fd.get("tagline")),
            monthlyPricePaise: Math.round(Number(fd.get("monthly")) * 100),
            annualPricePaise: annual ? Math.round(Number(annual) * 100) : null,
            maxWebsites: Number(fd.get("maxWebsites")),
            maxMembers: Number(fd.get("maxMembers")),
            features: String(fd.get("features")).split("\n").map((f) => f.trim()).filter(Boolean),
            highlight: fd.get("highlight") === "on",
            active: fd.get("active") === "on",
          },
          String(fd.get("confirm") ?? ""),
        );
      }}
    >
      <div className="font-semibold">{plan.code}</div>
      <input name="name" className="input" defaultValue={plan.name} aria-label="Name" />
      <input name="tagline" className="input" defaultValue={plan.tagline} aria-label="Tagline" />
      <div className="grid grid-cols-2 gap-2">
        <label>₹/month (excl. GST)<input name="monthly" type="number" step="1" min={1} className="input" defaultValue={plan.monthlyPricePaise / 100} /></label>
        <label>₹/year (blank = none)<input name="annual" type="number" step="1" min={1} className="input" defaultValue={plan.annualPricePaise ? plan.annualPricePaise / 100 : ""} /></label>
        <label>Websites<input name="maxWebsites" type="number" min={1} className="input" defaultValue={plan.maxWebsites} /></label>
        <label>Members<input name="maxMembers" type="number" min={1} className="input" defaultValue={plan.maxMembers} /></label>
      </div>
      <label className="block">Features (one per line)<textarea name="features" className="input min-h-28 text-xs" defaultValue={plan.features.join("\n")} /></label>
      <div className="flex gap-4">
        <label className="flex items-center gap-1"><input type="checkbox" name="highlight" defaultChecked={plan.highlight} /> Recommended</label>
        <label className="flex items-center gap-1"><input type="checkbox" name="active" defaultChecked={plan.active} /> Active</label>
      </div>
      <input name="confirm" className="input" placeholder={`Type ${plan.code} to confirm`} aria-label="Confirm plan code" />
      <button className="btn btn-primary w-full" disabled={busy}>Save {plan.name}</button>
    </form>
  );
}

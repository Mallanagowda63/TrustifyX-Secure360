"use client";

import Link from "next/link";
import { useState } from "react";
import type { PublicPlan } from "@/server/billing/plans";
import { Icon } from "./Icon";

const inr = (paise: number) => {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
};

const CTA: Record<string, string> = { STARTER: "Get Started", GROWTH: "Choose Growth", BUSINESS: "Choose Business" };

export function Pricing({ plans, annualEnabled, loggedIn }: { plans: PublicPlan[]; annualEnabled: boolean; loggedIn: boolean }) {
  const [cycle, setCycle] = useState<"MONTHLY" | "ANNUAL">("MONTHLY");
  const showAnnual = annualEnabled && plans.some((p) => p.annual);
  const taxRate = plans[0] ? plans[0].monthly.taxRateBp / 100 : 18;
  const inclusive = plans[0]?.monthly.pricesIncludeTax ?? false;

  const href = (code: string) => {
    const q = `plan=${code}&cycle=${cycle}`;
    return loggedIn ? `/checkout?${q}` : `/signup?${q}`;
  };

  return (
    <div>
      {showAnnual && (
        <div className="mb-10 flex justify-center">
          <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-full border border-slate-200 bg-white p-1 shadow-sm">
            {(["MONTHLY", "ANNUAL"] as const).map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={cycle === c}
                onClick={() => setCycle(c)}
                className={`rounded-full px-5 py-2 text-sm font-semibold transition ${cycle === c ? "bg-navy-950 text-white" : "text-slate-600 hover:text-navy-950"}`}
              >
                {c === "MONTHLY" ? "Monthly" : "Annual"}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {plans.map((p) => {
          const price = cycle === "ANNUAL" && p.annual ? p.annual : p.monthly;
          const monthsFree = p.annual ? Math.round(12 - p.annual.subtotalPaise / p.monthly.subtotalPaise) : 0;
          return (
            <div
              key={p.code}
              className={`relative flex flex-col rounded-2xl border bg-white p-7 transition hover:-translate-y-1 hover:shadow-xl ${p.highlight ? "border-royal-500 shadow-lg ring-2 ring-royal-500/20" : "border-slate-200 shadow-sm"}`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-royal-600 to-teal-500 px-3 py-1 text-xs font-semibold text-white">
                  Recommended
                </span>
              )}
              <h3 className="font-display text-xl font-bold text-navy-950">{p.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{p.tagline}</p>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="font-display text-4xl font-extrabold tracking-tight text-navy-950">
                  {inr(inclusive ? price.totalPaise : price.subtotalPaise)}
                </span>
                <span className="text-sm text-slate-500">/{cycle === "ANNUAL" ? "year" : "month"}</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {inclusive
                  ? `Includes ${taxRate}% GST`
                  : `+ ${taxRate}% GST · ${inr(price.totalPaise)} total per ${cycle === "ANNUAL" ? "year" : "month"}`}
                {cycle === "ANNUAL" && monthsFree > 0 ? ` · pay for ${12 - monthsFree} months, get 12` : ""}
              </p>
              <Link href={href(p.code)} className={`mk-btn mt-6 w-full ${p.highlight ? "mk-btn-primary" : "mk-btn-outline"}`}>
                {CTA[p.code] ?? `Choose ${p.name}`}
              </Link>
              <ul className="mt-7 space-y-3 text-sm text-slate-700">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2.5">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-600">
                      <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="mt-6 text-center text-xs text-slate-500">
        {cycle === "ANNUAL" ? "Billed yearly" : "Billed monthly"} through Razorpay.{" "}
        {inclusive ? "Prices include GST." : `Prices exclude ${taxRate}% GST, which is added at checkout.`} Cancel any time. Service
        continues until the end of the paid period.{" "}
        <Link href="/legal/refunds" className="underline hover:text-slate-700">
          Refund &amp; cancellation policy
        </Link>
      </p>

      <Comparison plans={plans} />
    </div>
  );
}

function Cell({ v }: { v: string | boolean }) {
  if (v === true)
    return (
      <span className="inline-flex items-center gap-1 text-teal-600">
        <Icon name="check" className="h-4 w-4" strokeWidth={2.5} />
        <span className="sr-only">Included</span>
      </span>
    );
  if (v === false)
    return (
      <span className="text-slate-300">
        <span aria-hidden>—</span>
        <span className="sr-only">Not included</span>
      </span>
    );
  return <span className="text-slate-700">{v}</span>;
}

function Comparison({ plans }: { plans: PublicPlan[] }) {
  const rows: Array<{ label: string; get: (p: PublicPlan) => string | boolean }> = [
    { label: "Verified websites", get: (p) => (p.limits.websites === 1 ? "1" : `Up to ${p.limits.websites}`) },
    { label: "Uptime checks", get: (p) => `Every ${Math.round(p.limits.availabilityIntervalSec / 60)} min` },
    { label: "SSL/TLS certificate monitoring", get: () => true },
    { label: "HTTP security-header checks", get: () => true },
    { label: "DNS change monitoring", get: () => true },
    { label: "Security findings dashboard", get: () => true },
    { label: "Email alerts (when SMTP is configured)", get: () => true },
    { label: "Downloadable PDF reports", get: () => true },
    { label: "Weekly & monthly emailed reports", get: (p) => p.limits.scheduledReports },
    { label: "AI security explanations", get: (p) => p.limits.aiAssistant },
    { label: "Team members", get: (p) => (p.limits.members === 1 ? "1" : `Up to ${p.limits.members}`) },
    { label: "Organization audit logs", get: (p) => p.limits.auditLogs },
  ];
  return (
    <div className="mt-16">
      <h3 className="text-center font-display text-2xl font-bold text-navy-950">Compare plans</h3>
      <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th scope="col" className="px-5 py-4 text-left font-semibold text-slate-600">
                Feature
              </th>
              {plans.map((p) => (
                <th key={p.code} scope="col" className="px-5 py-4 text-center font-semibold text-navy-950">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-slate-100 last:border-0">
                <th scope="row" className="px-5 py-3.5 text-left font-normal text-slate-600">
                  {r.label}
                </th>
                {plans.map((p) => (
                  <td key={p.code} className="px-5 py-3.5 text-center">
                    <Cell v={r.get(p)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

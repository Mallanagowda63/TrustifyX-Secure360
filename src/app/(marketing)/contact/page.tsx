import type { Metadata } from "next";
import { env } from "@/server/env";
import { Icon } from "@/components/marketing/Icon";

export const metadata: Metadata = { title: "Contact" };

export default function Contact() {
  const e = env();
  return (
    <section className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-4xl font-bold tracking-tight text-navy-950">Contact TrustifyX</h1>
      <p className="mt-4 text-lg text-slate-600">Questions about plans, billing or your monitoring results? We are happy to help.</p>
      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 p-6">
          <Icon name="mail" className="h-6 w-6 text-royal-600" />
          <h2 className="mt-3 font-display text-lg font-bold text-navy-950">Sales &amp; support</h2>
          <p className="mt-1 text-sm text-slate-600">Business-hours email support (Mon–Fri, IST).</p>
          <a className="mt-3 inline-block font-medium text-royal-700 underline" href={`mailto:${e.SUPPORT_EMAIL}`}>{e.SUPPORT_EMAIL}</a>
        </div>
        <div className="rounded-2xl border border-slate-200 p-6">
          <Icon name="shieldCheck" className="h-6 w-6 text-teal-600" />
          <h2 className="mt-3 font-display text-lg font-bold text-navy-950">Security reports</h2>
          <p className="mt-1 text-sm text-slate-600">Found a vulnerability in Secure360? Please report it responsibly.</p>
          <a className="mt-3 inline-block font-medium text-royal-700 underline" href={`mailto:${e.SECURITY_EMAIL}`}>{e.SECURITY_EMAIL}</a>
        </div>
      </div>
      <p className="mt-8 text-sm text-slate-500">
        {e.BILLING_SELLER_NAME}
        {e.BILLING_SELLER_ADDRESS ? ` · ${e.BILLING_SELLER_ADDRESS}` : ""}
      </p>
    </section>
  );
}

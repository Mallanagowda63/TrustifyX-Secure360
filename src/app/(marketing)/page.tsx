import Link from "next/link";
import { getPageSession } from "@/server/auth/page";
import { annualEnabled, listPlans, presentPlan } from "@/server/billing/plans";
import { env } from "@/server/env";
import { Icon } from "@/components/marketing/Icon";
import { Reveal } from "@/components/marketing/Reveal";
import { Pricing } from "@/components/marketing/Pricing";
import { ProductPreview } from "@/components/marketing/ProductPreview";
import { BENEFITS, FAQS, FEATURES, INTEGRATIONS, STEPS, WHY } from "@/lib/marketing";

function SectionHeading({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <p className="text-sm font-semibold tracking-wider text-teal-600 uppercase">{eyebrow}</p>
      <h2 className="mt-3 font-display text-3xl font-bold tracking-tight text-navy-950 sm:text-4xl">{title}</h2>
      {text && <p className="mt-4 text-lg leading-relaxed text-slate-600">{text}</p>}
    </div>
  );
}

export default async function HomePage() {
  const [session, plans, addons] = await Promise.all([getPageSession(), listPlans(), listPlans(false, "ADDON")]);
  const publicPlans = plans.map(presentPlan);
  const publicAddons = addons.map(presentPlan);
  const loggedIn = Boolean(session);
  const base = env().APP_URL.replace(/\/$/, "");

  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "TrustifyX Private Limited",
      url: base,
      contactPoint: { "@type": "ContactPoint", email: env().SUPPORT_EMAIL, contactType: "customer support" },
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "TrustifyX Secure360",
      applicationCategory: "SecurityApplication",
      operatingSystem: "Web",
      description: "AI-assisted website security monitoring: availability, SSL/TLS, HTTP security headers and DNS change monitoring.",
      offers: publicPlans.map((p) => ({
        "@type": "Offer",
        name: p.name,
        price: (p.monthly.subtotalPaise / 100).toFixed(2),
        priceCurrency: p.monthly.currency,
        url: `${base}/#pricing`,
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: FAQS.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />

      {/* ─── Hero ─── */}
      <section id="home" className="mk-section relative overflow-hidden bg-navy-950 text-white">
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute -top-40 -left-32 h-[32rem] w-[32rem] rounded-full bg-royal-600/30 blur-3xl" />
          <div className="absolute top-20 -right-40 h-[28rem] w-[28rem] rounded-full bg-teal-500/20 blur-3xl" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
        </div>
        <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-2 lg:pt-24 lg:pb-28">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-teal-200">
              <Icon name="shieldCheck" className="h-4 w-4" /> Website security monitoring for Indian businesses
            </p>
            <h1 className="mt-6 font-display text-4xl leading-[1.1] font-extrabold tracking-tight sm:text-5xl lg:text-6xl">
              Secure Your Website. Protect Your Business.{" "}
              <span className="bg-gradient-to-r from-royal-400 to-teal-300 bg-clip-text text-transparent">Powered by AI.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
              Monitor website availability, SSL certificates, security configurations and potential risks from one powerful AI-assisted
              cybersecurity dashboard.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a href="#pricing" className="mk-btn mk-btn-primary px-6 py-3.5 text-base">
                Get Protected Now <Icon name="arrow" className="h-4 w-4" />
              </a>
              <a href="#pricing" className="mk-btn border border-white/25 px-6 py-3.5 text-base text-white hover:bg-white/10">
                Explore Pricing
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-400">
              <li className="flex items-center gap-1.5"><Icon name="check" className="h-4 w-4 text-teal-300" /> No code or agent to install</li>
              <li className="flex items-center gap-1.5"><Icon name="check" className="h-4 w-4 text-teal-300" /> Verified-owner monitoring</li>
              <li className="flex items-center gap-1.5"><Icon name="check" className="h-4 w-4 text-teal-300" /> GST invoices via Razorpay</li>
            </ul>
          </div>
          <Reveal>
            <ProductPreview />
          </Reveal>
        </div>
      </section>

      {/* ─── Benefits ─── */}
      <section className="border-b border-slate-200 bg-slate-50 py-16" aria-labelledby="benefits-heading">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <h2 id="benefits-heading" className="sr-only">Benefits</h2>
          <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {BENEFITS.map((b, i) => (
              <Reveal key={b.title} delay={i * 60}>
                <div className="flex gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-royal-600 shadow-sm ring-1 ring-slate-200">
                    <Icon name={b.icon} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-navy-950">{b.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{b.text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ─── How it works ─── */}
      <section id="how-it-works" className="mk-section py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHeading eyebrow="How it works" title="From sign-up to monitoring in four steps" text="Every step is checked by our servers. Monitoring never starts on a website whose ownership has not been verified." />
          <ol className="relative mt-16 grid gap-10 lg:grid-cols-4">
            <div className="absolute top-7 right-[12.5%] left-[12.5%] hidden h-0.5 bg-gradient-to-r from-royal-500 via-royal-400 to-teal-400 lg:block" aria-hidden />
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={i * 100}>
                <li className="relative text-center">
                  <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-royal-600 to-teal-500 text-white shadow-lg">
                    <Icon name={s.icon} className="h-6 w-6" />
                    <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-navy-950 text-xs font-bold ring-2 ring-white">{i + 1}</span>
                  </div>
                  <h3 className="mt-5 font-display text-lg font-bold text-navy-950">{s.title}</h3>
                  <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-slate-600">{s.text}</p>
                </li>
              </Reveal>
            ))}
          </ol>
          <div className="mx-auto mt-14 flex max-w-3xl items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <Icon name="shieldCheck" className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              <strong>Domain verification is mandatory.</strong> After payment your subscription shows <em>“Subscription Active, Website
              Verification Required”</em> until you prove control of your domain with a DNS TXT record or a hosted verification file.
            </p>
          </div>
        </div>
      </section>

      {/* ─── Features ─── */}
      <section id="features" className="mk-section bg-slate-50 py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHeading eyebrow="Features" title="Everything you need to watch your website's security posture" text="Passive, external checks that show what your visitors and attackers can see, explained in plain language." />
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={(i % 4) * 70}>
                <div className="group h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-royal-200 hover:shadow-lg">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-royal-50 to-teal-50 text-royal-600 ring-1 ring-royal-100 transition group-hover:from-royal-600 group-hover:to-teal-500 group-hover:text-white">
                    <Icon name={f.icon} />
                  </div>
                  <h3 className="mt-5 font-display text-base font-bold text-navy-950">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.text}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="mt-16 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="font-display text-lg font-bold text-navy-950">Advanced integrations</h3>
                <p className="mt-1 text-sm text-slate-600">Optional data sources, kept separate from basic URL monitoring. These are not yet available and will not be sold until they are.</p>
              </div>
            </div>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {INTEGRATIONS.map((i) => (
                <li key={i.name} className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3">
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <Icon name={i.icon} className="h-5 w-5 text-slate-500" /> {i.name}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{i.note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ─── Pricing ─── */}
      <section id="pricing" className="mk-section py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <SectionHeading eyebrow="Pricing" title="Simple plans that grow with your websites" text="Choose a plan, pay securely through Razorpay, verify your website and start monitoring." />
          <div className="mt-14">
            <Pricing plans={publicPlans} annualEnabled={annualEnabled()} loggedIn={loggedIn} />
          </div>
          {publicAddons.map((a) => (
            <div key={a.code} className="mx-auto mt-10 flex max-w-4xl flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold tracking-wider text-royal-600 uppercase">Optional add-on</p>
                <h3 className="mt-1 text-lg font-semibold text-slate-900">{a.name}</h3>
                <p className="mt-1 max-w-xl text-sm text-slate-600">
                  {a.description} Uses your own Cloudflare account; any Cloudflare plan charges are billed by Cloudflare. Requires an active plan.
                </p>
              </div>
              <div className="shrink-0 text-left sm:text-right">
                <p className="text-2xl font-bold text-slate-900">
                  ₹{(a.monthly.subtotalPaise / 100).toLocaleString("en-IN")}
                  <span className="text-sm font-normal text-slate-500">/mo + GST</span>
                </p>
                <a href={loggedIn ? `/checkout?addon=${a.code}&cycle=MONTHLY` : "/signup"} className="mt-2 inline-block text-sm font-semibold text-royal-600 hover:underline">
                  {loggedIn ? "Add to your plan →" : "Start with a plan →"}
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── Why TrustifyX ─── */}
      <section id="why-trustifyx" className="mk-section bg-navy-950 py-24 text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-sm font-semibold tracking-wider text-teal-300 uppercase">Why TrustifyX</p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">Honest monitoring you can trust</h2>
            <p className="mt-4 text-lg text-slate-300">We tell you exactly what we check, and what we don't.</p>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-2">
            {WHY.map((w, i) => (
              <Reveal key={w.title} delay={i * 80}>
                <div className="flex h-full gap-4 rounded-2xl border border-white/10 bg-white/5 p-6">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-royal-500 to-teal-500">
                    <Icon name={w.icon} />
                  </div>
                  <div>
                    <h3 className="font-display text-lg font-bold">{w.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-300">{w.text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mx-auto mt-10 max-w-3xl rounded-xl border border-white/15 bg-white/5 p-5 text-sm text-slate-300">
            <strong className="text-white">What basic monitoring does not do:</strong> it does not detect every hacking attempt, scan for malware,
            inspect your server or traffic, or fix issues for you. For deeper visibility, see the integrations above (coming soon).
          </div>
        </div>
      </section>

      {/* ─── FAQ ─── */}
      <section id="faqs" className="mk-section bg-slate-50 py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <SectionHeading eyebrow="FAQs" title="Frequently asked questions" />
          <div className="mt-12 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
            {FAQS.map((f) => (
              <details key={f.q} className="group p-5 sm:p-6 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-navy-950">
                  {f.q}
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition group-open:rotate-45" aria-hidden>
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Final CTA ─── */}
      <section className="py-24">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-navy-950 via-royal-700 to-teal-600 px-6 py-14 text-center text-white sm:px-12">
            <div className="absolute -top-24 -right-24 h-64 w-64 rounded-full bg-white/10 blur-2xl" aria-hidden />
            <h2 className="relative font-display text-3xl font-bold sm:text-4xl">Start monitoring your website today</h2>
            <p className="relative mx-auto mt-4 max-w-2xl text-lg text-blue-100">
              Choose a plan, verify your domain, and see clear, evidence-based findings in your dashboard.
            </p>
            <div className="relative mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <a href="#pricing" className="mk-btn mk-btn-light px-6 py-3.5 text-base">
                Get Protected Now
              </a>
              <Link href="/contact" className="mk-btn border border-white/40 px-6 py-3.5 text-base text-white hover:bg-white/10">
                Talk to us
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

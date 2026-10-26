import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "About TrustifyX" };

export default function About() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-4xl font-bold tracking-tight text-navy-950">About TrustifyX</h1>
      <div className="mt-8 space-y-5 text-lg leading-relaxed text-slate-700">
        <p>
          TrustifyX Private Limited builds practical cybersecurity tools for businesses that need clear answers without a dedicated
          security team.
        </p>
        <p>
          Secure360, our website monitoring platform, focuses on what can be verified from outside your website: whether it is up,
          whether its certificate is healthy, how its security headers are configured and whether its DNS has changed. Each result comes
          with the evidence behind it and a plain-language explanation.
        </p>
        <p>
          We are deliberately transparent about limits: Secure360 does not claim to detect every attack, and it never scans websites
          their owners have not verified.
        </p>
      </div>
      <div className="mt-10 flex gap-3">
        <Link href="/#pricing" className="mk-btn mk-btn-primary">View plans</Link>
        <Link href="/contact" className="mk-btn mk-btn-outline">Contact us</Link>
      </div>
    </section>
  );
}

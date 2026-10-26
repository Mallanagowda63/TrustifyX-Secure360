import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { LegalPage } from "@/components/marketing/LegalPage";

const UPDATED = "26 October 2026";
const TITLES: Record<string, string> = {
  privacy: "Privacy Policy",
  terms: "Terms of Service",
  refunds: "Refund & Cancellation Policy",
};

export function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  return params.then(({ slug }) => ({ title: TITLES[slug] ?? "Legal" }));
}

export default async function Legal({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const e = env();
  const support = e.SUPPORT_EMAIL;
  const grace = e.BILLING_GRACE_DAYS;

  if (slug === "privacy") {
    return (
      <LegalPage title={TITLES.privacy} updated={UPDATED}>
        <p>
          This policy explains how TrustifyX Private Limited (“TrustifyX”, “we”) processes personal data when you use TrustifyX Secure360
          (the “Service”). Questions: <a href={`mailto:${support}`}>{support}</a>.
        </p>
        <h2>What we collect</h2>
        <ul>
          <li>Account data: name, email address, organization name, hashed password (argon2id), team roles.</li>
          <li>Monitoring data about websites you verify: HTTP status and response times, TLS certificate details, HTTP response headers (cookie values are never stored, only cookie names and flags), DNS records, and findings derived from them.</li>
          <li>Billing data: plan, payment status, amounts, invoices and Razorpay payment/subscription identifiers. Card, UPI and bank details are collected and processed by Razorpay, not by us.</li>
          <li>Security logs: sign-in events, IP addresses and an audit trail of account actions.</li>
        </ul>
        <h2>How we use it</h2>
        <ul>
          <li>To provide monitoring, alerts, reports and billing; to secure the Service and prevent abuse; to meet legal and tax obligations.</li>
          <li>AI features (where enabled): a minimal, redacted subset of monitoring data (hostnames, findings, check summaries) is sent to our AI provider to generate explanations. Account details, credentials and emails are not sent.</li>
        </ul>
        <h2>Sharing</h2>
        <p>We share data only with processors needed to run the Service (hosting, email delivery, Razorpay for payments, the configured AI provider) and where required by law. We do not sell personal data.</p>
        <h2>Retention</h2>
        <p>Monitoring history is kept for up to 400 days. Billing records are kept as required by Indian tax law. You may request deletion of your account data, subject to those obligations.</p>
        <h2>Your rights</h2>
        <p>You may request access to, correction of, or deletion of your personal data under applicable law, including the Digital Personal Data Protection Act, 2023. Contact <a href={`mailto:${support}`}>{support}</a>.</p>
      </LegalPage>
    );
  }

  if (slug === "terms") {
    return (
      <LegalPage title={TITLES.terms} updated={UPDATED}>
        <p>These terms govern your use of TrustifyX Secure360, provided by TrustifyX Private Limited, India.</p>
        <h2>The Service</h2>
        <p>
          Secure360 performs passive, external checks (availability, TLS certificates, HTTP security headers, HTTPS redirects and DNS
          records) of websites you have verified you control, and presents findings, alerts, reports and AI-assisted explanations. It does
          not detect all attacks, scan for malware, access your servers, or perform remediation. No uptime or security outcome is
          guaranteed.
        </p>
        <h2>Your responsibilities</h2>
        <ul>
          <li>You must own each website you add or be authorized by its owner to monitor it, and you confirm this when verifying ownership.</li>
          <li>Keep your account credentials secure and your team’s roles appropriate.</li>
          <li>Do not use the Service to target websites you are not authorized to monitor or to disrupt any system.</li>
        </ul>
        <h2>Subscriptions and payment</h2>
        <p>
          Paid plans are billed in advance through Razorpay for the selected billing period. Prices exclude GST unless stated. Plan
          entitlements (such as the number of websites) are enforced automatically. See the Refund &amp; Cancellation Policy.
        </p>
        <h2>AI features</h2>
        <p>AI explanations are generated from your monitoring data and may be incomplete or wrong. Review them before acting. The AI never changes your systems.</p>
        <h2>Limitation of liability</h2>
        <p>To the extent permitted by law, TrustifyX’s aggregate liability is limited to the fees you paid in the three months before the claim. (Review required.)</p>
        <h2>Governing law</h2>
        <p>These terms are governed by the laws of India. (Jurisdiction clause to be confirmed by counsel.)</p>
      </LegalPage>
    );
  }

  if (slug === "refunds") {
    return (
      <LegalPage title={TITLES.refunds} updated={UPDATED}>
        <h2>Billing periods</h2>
        <ul>
          <li><strong>Recurring plans</strong> renew automatically at the end of each period through Razorpay until cancelled.</li>
          <li><strong>Prepaid plans</strong> (if offered) do not renew automatically; you will be reminded before the period ends.</li>
          <li>Your subscription activates only after the payment is confirmed by Razorpay and verified by our servers.</li>
        </ul>
        <h2>Cancellation</h2>
        <ul>
          <li>You can cancel from Billing at any time. By default cancellation takes effect at the <strong>end of the current paid period</strong>, and the service continues until that date.</li>
          <li>If you choose “cancel immediately”, access ends at once and no refund is issued for the unused part of the period.</li>
          <li>After cancellation or expiry, monitoring pauses but your websites, findings and reports are retained per our Privacy Policy, and monitoring resumes if you subscribe again.</li>
        </ul>
        <h2>Failed payments</h2>
        <p>If a renewal payment fails, Razorpay retries it. Service continues for a grace period of {grace} days. If payment is not completed by then, monitoring pauses until payment succeeds.</p>
        <h2>Plan changes</h2>
        <ul>
          <li><strong>Upgrades</strong> start a new billing period on the new plan as soon as the new payment is confirmed; the previous plan ends at that time. Unused time on the previous plan is not refunded or credited. (Review: consider pro-rated credit.)</li>
          <li><strong>Downgrades</strong> take effect at the end of the current period. If you have more websites than the new plan allows, the extra websites are paused, never deleted.</li>
        </ul>
        <h2>Refunds</h2>
        <ul>
          <li>Payments are generally non-refundable once a billing period has started.</li>
          <li>If you were charged in error (for example a duplicate charge), contact <a href={`mailto:${support}`}>{support}</a> within 7 days and we will refund the erroneous amount to the original payment method through Razorpay.</li>
          <li>When a full refund is issued for the current period, that subscription ends immediately and monitoring pauses.</li>
          <li>Refunds typically reach the original payment method within 5–7 working days, depending on your bank.</li>
        </ul>
      </LegalPage>
    );
  }

  notFound();
}

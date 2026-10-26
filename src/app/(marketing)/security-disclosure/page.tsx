import type { Metadata } from "next";
import { env } from "@/server/env";
import { LegalPage } from "@/components/marketing/LegalPage";

export const metadata: Metadata = { title: "Security disclosure" };

export default function SecurityDisclosure() {
  const email = env().SECURITY_EMAIL;
  return (
    <LegalPage title="Security vulnerability disclosure" updated="26 October 2026">
      <p>
        We welcome reports of security vulnerabilities in TrustifyX Secure360. Please email <a href={`mailto:${email}`}>{email}</a> with a
        description, steps to reproduce and the impact you observed.
      </p>
      <h2>Guidelines</h2>
      <ul>
        <li>Test only against your own account and data. Do not access, modify or delete other customers’ data.</li>
        <li>Do not run denial-of-service, spam, social-engineering or physical attacks.</li>
        <li>Give us reasonable time to fix the issue before public disclosure.</li>
      </ul>
      <h2>Our commitment</h2>
      <ul>
        <li>We will acknowledge your report within 3 business days and keep you informed of progress.</li>
        <li>We will not pursue legal action against good-faith research that follows these guidelines.</li>
      </ul>
      <p>
        Machine-readable contact: <code>/.well-known/security.txt</code>.
      </p>
    </LegalPage>
  );
}

/**
 * Marketing copy. Every claim here maps to an implemented capability (see README "What it
 * does"); nothing advertises attack detection, malware scanning, guarantees or SOC services.
 */

export const BENEFITS = [
  { icon: "activity", title: "Automated monitoring", text: "Checks run on a schedule, with no agents or code snippets to install." },
  { icon: "list", title: "Clear security findings", text: "Each issue comes with its evidence, a severity and a plain-language explanation." },
  { icon: "sparkles", title: "AI-assisted guidance", text: "Explanations and prioritised next steps are generated only from your verified results." },
  { icon: "radar", title: "Availability tracking", text: "Response-time and uptime history, with downtime confirmed before you are alerted." },
  { icon: "lock", title: "SSL/TLS monitoring", text: "Certificate trust, expiry and issuer are tracked, with reminders before expiry." },
  { icon: "report", title: "Security reports", text: "PDF reports you can download any time or receive by email each week or month." },
  { icon: "bell", title: "Automated alerts", text: "Email alerts are deduplicated, and you are told when a problem recovers." },
];

export const STEPS = [
  { icon: "card", title: "Choose a plan", text: "Pick Starter, Growth or Business. GST is added at checkout and shown before you pay." },
  { icon: "lock", title: "Complete secure payment", text: "Pay through Razorpay Checkout. Your subscription activates only after the payment is verified on our servers." },
  { icon: "shieldCheck", title: "Connect & verify your website", text: "Add your HTTPS site, then prove you control it with a DNS TXT record or a verification file. Verification is required." },
  { icon: "activity", title: "Automated monitoring starts", text: "Checks start automatically. You can follow uptime, certificates, headers and DNS from your dashboard." },
];

export const FEATURES = [
  { icon: "activity", title: "Website uptime monitoring", text: "HTTP checks every 5 minutes, with a retry. Downtime is confirmed after consecutive failures, and recovery is reported." },
  { icon: "lock", title: "SSL/TLS certificate monitoring", text: "Trust chain, hostname match, protocol, issuer and days to expiry. Reminders go out 30, 14, 7, 3 and 1 day before expiry." },
  { icon: "headers", title: "HTTP security header checks", text: "HSTS, Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, clickjacking protection and cookie flags." },
  { icon: "globe", title: "DNS change monitoring", text: "Tracks changes to A, AAAA, CNAME, NS, MX and CAA records and to SPF and DMARC, with a before-and-after history." },
  { icon: "sparkles", title: "AI security explanations", text: "Plain-language explanations and safe remediation steps, based only on your verified findings. Available on Growth and Business." },
  { icon: "mail", title: "Automated email alerts", text: "Alerts for downtime, recovery, certificate expiry, and new or resolved findings. Each person chooses which alerts they get." },
  { icon: "report", title: "Cybersecurity reports", text: "Downloadable PDF reports covering availability, incidents, findings and configuration changes." },
  { icon: "layout", title: "Multi-website dashboard", text: "Monitor up to 20 websites from one organization, with team roles and an audit trail." },
];

export const INTEGRATIONS = [
  { icon: "cloud", name: "Cloudflare WAF", note: "Coming soon" },
  { icon: "server", name: "Wazuh", note: "Coming soon" },
  { icon: "github", name: "GitHub security alerts", note: "Coming soon" },
  { icon: "radar", name: "OWASP ZAP baseline", note: "Coming soon" },
];

export const WHY = [
  { icon: "shieldCheck", title: "Verified-owner monitoring only", text: "We only check websites whose ownership is proven and whose owner has authorized monitoring. Ownership is re-checked daily." },
  { icon: "eye", title: "Non-intrusive by design", text: "We make standard HTTPS requests, TLS handshakes and DNS lookups only. We never send attack payloads, brute force, exploit or scan ports." },
  { icon: "sparkles", title: "Grounded AI, no invented threats", text: "The AI works only from your monitoring data and never makes changes to your systems. It is prevented from citing CVEs that are not in your data." },
  { icon: "key", title: "Built with security in mind", text: "Each customer's data is kept separate, passwords are hashed with argon2id, sessions use secure cookies, and the platform checks every action it performs." },
];

export const FAQS = [
  {
    q: "Do I need to install anything on my website?",
    a: "No. Basic monitoring works from outside your website, with no JavaScript snippet or agent. You only add a DNS TXT record or upload a small text file once, to prove you control the domain.",
  },
  {
    q: "Why is domain verification required?",
    a: "We only monitor websites whose owners have authorized it. Until ownership is verified, your subscription shows “Website Verification Required” and no checks run. Ownership is re-checked daily, so keep the record or file in place.",
  },
  {
    q: "Does Secure360 detect hacking attempts or malware?",
    a: "No, and we do not claim to. Basic monitoring watches availability, SSL/TLS certificates, HTTP security headers, HTTPS redirects and DNS from outside your website. It can show configuration weaknesses and outages, but it cannot see your server's internals or traffic, so it is not a malware scanner or an intrusion detection system.",
  },
  {
    q: "When does my subscription start, and how is payment verified?",
    a: "Your subscription becomes active only after Razorpay confirms that the payment was collected, and our servers verify it independently. Your browser alone can never activate a plan. After that, add and verify your website, and monitoring starts automatically.",
  },
  {
    q: "Are prices inclusive of GST?",
    a: "Listed prices exclude GST. 18% GST is added at checkout and shown before you pay. Each payment comes with a receipt you can download from Billing.",
  },
  {
    q: "Can I change or cancel my plan?",
    a: "Yes. Upgrades take effect as soon as the new payment is confirmed. Downgrades take effect at the end of your current billing period. You can cancel at the end of the period, and service continues until then. See our Refund & Cancellation Policy for details.",
  },
  {
    q: "What happens if I downgrade or a payment fails?",
    a: "Your data is never deleted because of billing. If you downgrade below the number of websites you have, the extra websites are paused, not removed. If a renewal fails, monitoring continues through a grace period while the payment is retried. If payment is not completed by then, monitoring pauses and resumes automatically when you pay.",
  },
  {
    q: "Do you fix security issues for me?",
    a: "No. Secure360 explains what it found and recommends safe remediation steps, but your team makes the changes. Remediation services and 24/7 SOC monitoring are not included in any plan.",
  },
];

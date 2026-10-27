# Production readiness checklist

Items marked **BLOCKER** must be done before taking real customers' money.

## Credentials and third parties (not in the repository)

| Item | Variable(s) | Status |
|---|---|---|
| **BLOCKER** Razorpay account KYC + live activation | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Not configured (test keys first) |
| **BLOCKER** Razorpay webhook (live) | `RAZORPAY_WEBHOOK_SECRET` | Not configured |
| Razorpay Subscriptions enabled (else `BILLING_MODE=prepaid`) | `BILLING_MODE` | To confirm with Razorpay |
| **BLOCKER** Transactional email (alerts, invoices, onboarding) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | Not configured: emails are recorded as Skipped |
| AI provider (Growth/Business feature) | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | Optional; UI shows "not configured" |
| Encryption key (backed up separately) | `ENCRYPTION_KEY` | Generate per environment |
| Seller details on invoices | `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_GSTIN` | To fill |
| Support / security mailboxes exist and are monitored | `SUPPORT_EMAIL`, `SECURITY_EMAIL` | To create |

## Legal, tax and policy

- [ ] **BLOCKER** Legal review of Terms, Privacy Policy (incl. DPDP Act 2023), Refund & Cancellation Policy; then remove "Draft for review" banners.
- [ ] **BLOCKER** Accountant review: GST registration, 18% rate, SAC code, place of supply and invoice format (`src/server/billing/invoice-pdf.ts`).
- [ ] Publish a support policy matching the Business plan's "business-hours email support" claim.
- [ ] Decide pro-rata policy for upgrades (currently: no credit, stated in the policy).

## Platform

- [ ] Follow `docs/DEPLOYMENT.md` (Docker, nginx TLS, `deploy/egress-firewall.sh apply`, backups).
- [ ] `APP_URL` (marketing) and `PORTAL_URL` (portal) are the HTTPS domains (enables `__Host-` secure cookies); `TRUST_PROXY=true` behind nginx.
- [ ] DNS A/AAAA records for both hostnames; one certificate covers both; nginx passes `Host`.
- [ ] `MONITOR_ALLOW_PRIVATE_TARGETS` unset.
- [ ] Platform admin promoted (`npm run admin:promote`); existing customers migrated with `npm run billing:grant` if needed.
- [ ] External uptime check on `/api/health`; alert on worker container restarts.
- [ ] Off-site database backups and a restore test.

## Verification before launch

- [ ] `npm test` green, `npm run typecheck`, `npm run build`.
- [ ] Test-mode run of `docs/BILLING.md` → "Manual" table, including webhook resend and refund.
- [ ] One small **live** payment + refund after activation; verify invoice, email and `/admin`.
- [ ] Connect TrustifyX's own website end to end (`docs/ONBOARDING.md`).

## Two-website verification

Run these against the deployed domains in a fresh private window, and record the results.

- [ ] `https://secure360.trustifyx.in/` shows the homepage and pricing; `/dashboard` redirects to the portal.
- [ ] `https://portal.trustifyx.in/` redirects to `/login` when signed out; the login page has no signup button; "Explore Plans" opens marketing pricing.
- [ ] `https://portal.trustifyx.in/signup` and `/checkout` redirect to marketing `/#pricing`; an unknown portal path returns 404.
- [ ] Sign up and pay (Razorpay **test** mode) on marketing. `/account` shows the plan only after the server confirms it (the webhook is delivered in the Razorpay dashboard).
- [ ] "Open Security Dashboard" signs in to the portal without a second login. The address bar never contains a session token, and Local Storage is empty.
- [ ] Logging in directly on the portal with the same credentials works (same account, no duplicate user).
- [ ] Logout on the portal also signs out the marketing session that SSO created.
- [ ] Forgot password: the email arrives, the link opens on the portal, works once, and signs the user out elsewhere.
- [ ] Check Your Website Security: an unverified site is never scanned; after verification, "Initial Security Check in Progress" turns into real results.
- [ ] An account without a subscription sees "Subscription Required" with **View Pricing Plans**, and cannot add websites.
- [ ] A second organization cannot see the first one's websites (open a website URL from the other account: 404).
- [ ] The portal pages work at phone width (390 px) with no horizontal scrolling.
- [ ] Response headers: HSTS on both hosts, `X-Robots-Tag: noindex` on the portal, CSP present.
- [ ] Live payments are enabled only after KYC and approval. A test-mode payment is not evidence that live payments work.

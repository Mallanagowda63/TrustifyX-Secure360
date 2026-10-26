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
- [ ] `APP_URL` is the HTTPS domain (enables `__Host-` secure cookies); `TRUST_PROXY=true` behind nginx.
- [ ] `MONITOR_ALLOW_PRIVATE_TARGETS` unset.
- [ ] Platform admin promoted (`npm run admin:promote`); existing customers migrated with `npm run billing:grant` if needed.
- [ ] External uptime check on `/api/health`; alert on worker container restarts.
- [ ] Off-site database backups and a restore test.

## Verification before launch

- [ ] `npm test` green, `npm run typecheck`, `npm run build`.
- [ ] Test-mode run of `docs/BILLING.md` → "Manual" table, including webhook resend and refund.
- [ ] One small **live** payment + refund after activation; verify invoice, email and `/admin`.
- [ ] Connect TrustifyX's own website end to end (`docs/ONBOARDING.md`).

# Billing & payments (Razorpay)

How Secure360 sells subscriptions, how payment becomes monitoring, and how to configure and test it. Code lives in `src/server/billing/`.

## How it works

```
Pricing page ─► /checkout (server reads price from PricingPlan) ─► POST /api/billing/checkout
      │                                                            creates Razorpay subscription/order
      ▼
Razorpay Checkout (browser) ─► handler ─► POST /api/billing/verify
      │                                  1. HMAC signature check with SERVER-stored ids
      │                                  2. fetch subscription/payment from Razorpay API (authoritative)
      ▼                                  3. ACTIVE only if Razorpay says active AND a charge was collected
Razorpay webhook ─► POST /api/webhooks/razorpay
                    1. HMAC over raw body (X-Razorpay-Signature); forged → 400, never stored
                    2. stored once per X-Razorpay-Event-Id (duplicates acknowledged, not reprocessed)
                    3. worker processes it: re-fetches latest state from Razorpay (out-of-order safe)
Worker every 10 min ─► reconcileBilling(): retry stuck events, pull state for due/past-due
                       subscriptions (missed webhooks), expire prepaid/complimentary periods,
                       reminders, then align monitoring with entitlements
```

**Entitlement → monitoring.** `getEntitlement(org)` derives the active plan from subscription rows. `reconcileOrgMonitoring(org)` (`monitoring-gate.ts`) runs after every billing change. A website is monitored only when **all three** hold:

1. active entitlement (paid, in grace, or a labelled complimentary grant),
2. verified ownership (DNS TXT / file, re-checked daily),
3. customer authorization (recorded at verification).

Each monitoring job also re-checks the entitlement before making any request.

| Situation | What happens |
|---|---|
| Paid, website not verified | Banner "Subscription Active · Website Verification Required"; nothing is checked |
| Renewal payment fails | `PAST_DUE`/`HALTED`, monitoring continues until `graceUntil` (`BILLING_GRACE_DAYS`, default 7), owners/admins emailed |
| Grace over | Sites paused with reason `SUBSCRIPTION_INACTIVE`; data kept |
| Payment succeeds again | Sites paused by billing resume automatically and a scan is queued |
| Downgrade below site count | Oldest sites keep their slots; others paused `PLAN_LIMIT`; nothing deleted |
| Customer paused a site | Never auto-resumed by billing (`pausedReason = USER`) |
| Cancel at period end | Service until period end, then paused |
| Cancel now / full refund | Ends immediately, monitoring paused, invoice voided (refund) |

**Plan changes.** Razorpay's update-subscription API does not support UPI or e-mandate subscriptions, so plan changes create a new Razorpay subscription:

- **Upgrade:** charged now. When the new subscription is confirmed active, the old one is cancelled immediately at Razorpay (no pro-rata credit, as stated in the refund policy).
- **Downgrade:** new subscription with `start_at` = current period end. When the customer authorises it, the old one is set to cancel at cycle end.

**Prices.** `PricingPlan` rows hold prices in paise, excluding GST unless `BILLING_PRICES_INCLUDE_TAX=true`. Checkout charges price + GST, computed by `priceFor()` on the server. Razorpay plans are immutable, so each (plan, cycle, amount) maps to its own Razorpay plan (`ProviderPlan`). Changing a price affects new checkouts only; existing subscribers keep their agreed amount.

**Admins cannot fabricate payments.** No API sets a payment or subscription as paid. Operators can grant **complimentary** access (mode `COMPLIMENTARY`, amount 0, reason required, no Payment row, audited), edit catalog prices for future checkouts (type-to-confirm, audited), and trigger reconciliation or reprocess a stored, signature-verified webhook.

## Data model

| Model | Purpose |
|---|---|
| `PricingPlan` | Catalog: prices, limits (websites, members), feature flags, marketing features |
| `ProviderPlan` | Map of (plan, cycle, amount) to Razorpay `plan_id` |
| `Subscription` | One per purchase/grant: mode, status, provider ids, period, grace, cancellation, replacement link |
| `Payment` | One per Razorpay payment id (unique); status only moves forward |
| `Invoice` | One per captured payment (unique), sequential `TXS-YYYY-NNNNNN`, GST breakdown |
| `PaymentWebhookEvent` | Verified events, unique `eventId`, status/attempts/error |
| `BillingAuditLog` | Append-only trail of every billing action (user, admin, webhook, system) |

## Configure Razorpay (test mode first)

1. Sign up at https://dashboard.razorpay.com and stay in **Test Mode** (toggle top-right).
2. **API keys:** Account & Settings → API Keys → Generate Test Key. Put them in `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
   ```
3. **Subscriptions:** confirm the Subscriptions product is enabled for your account (Dashboard → Subscriptions). If recurring payments are not available, set `BILLING_MODE=prepaid`. Customers then pay one-time orders and renew manually with reminders; the UI never promises auto-renewal in that mode.
4. **Webhook:** Account & Settings → Webhooks → Add New Webhook
   - URL: `https://<your-domain>/api/webhooks/razorpay`. Locally, use a tunnel such as `cloudflared tunnel --url http://localhost:3000` or ngrok.
   - Secret: a long random string → `RAZORPAY_WEBHOOK_SECRET`
   - Active events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused`, `subscription.resumed`, `subscription.updated`, `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`
5. Optional: `BILLING_ANNUAL_ENABLED=true` to offer annual plans (default catalog: 10× monthly for 12 months). Leave it off unless you intend to sell annual plans.
6. Set invoice details: `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_GSTIN`, and **review the tax treatment with your accountant** (GST rate, SAC code, place of supply).
7. Restart web and worker. `/billing` should no longer show "Online payments are not configured".

The webhook route is excluded from CSRF/cookie auth by design; its only authentication is the HMAC over the raw body.

## Test guide (Razorpay test mode)

Automated (no Razorpay account needed: an in-memory provider fake plus real HMAC signatures):

```bash
npm test                                   # all suites
npx vitest run tests/integration/billing.test.ts tests/integration/journey.test.ts tests/unit/billing-unit.test.ts
```

Covered: server-side pricing/GST, client-supplied amount rejected, success, failed payment, forged checkout signature, forged webhook (not stored), duplicate webhook, out-of-order webhook, missed webhook recovered by reconciliation, renewal, grace and expiry, refund, cancellation (end of period / now), upgrade, downgrade with excess sites paused, prepaid capture idempotency and manual renewal, abandoned checkouts, plan limits, feature gating, monitoring gate (unpaid / unverified / user-paused), cross-org isolation, admin price edits, and the full journey through the route handlers.

Manual, with real test keys:

| Scenario | How |
|---|---|
| Successful card | Card `4111 1111 1111 1111`, any future expiry, any CVV, OTP per Razorpay test page |
| Failed payment | Use a failure test card/UPI from Razorpay's [test card docs](https://razorpay.com/docs/payments/payments/test-card-details/), or click "Failure" on the test bank page |
| UPI success / failure | `success@razorpay` / `failure@razorpay` |
| Duplicate webhook | Dashboard → Webhooks → resend an event: the API answers `duplicate: true` and nothing changes |
| Missed webhook | Disable the webhook, pay, then use **Refresh status** on `/billing` or wait for the 10-minute reconciliation |
| Refund | Dashboard → Payments → Refund (full): subscription ends, invoice shows "Refunded", sites pause |
| Cancellation | `/billing` → Cancel at period end / Cancel now |
| Renewal / failure | Razorpay test mode can simulate subscription charges from the dashboard where available. Otherwise rely on the automated tests above |

Confirm in `/admin` (platform admin) that events show as processed and no webhook failures remain.

> Test-mode transactions are not real payments. Do not treat a successful test checkout as proof that live payments work; repeat a small live transaction after KYC.

## Going live

1. Complete Razorpay KYC and activation, then generate **Live** keys (`rzp_live_...`).
2. Create a separate live webhook with a new secret.
3. Replace the three `RAZORPAY_*` values in production `.env`, restart web and worker.
4. Make a small real purchase, refund it, and verify invoices, emails and the admin console.
5. Have the legal pages (Terms, Privacy, Refund & Cancellation) and invoice tax wording reviewed and remove the draft notices (`draft` prop in `src/components/marketing/LegalPage.tsx`).

## Operations

- **Existing / pilot customers:** `npm run billing:grant -- owner@company.com GROWTH 90 "Pilot customer"` (or the `/admin` form). Revoke from `/admin`.
- **Platform admin:** `npm run admin:promote -- you@trustifyx.com`, then open `/admin`.
- **Change prices:** `/admin` → Plan catalog → type the plan code to confirm. Applies to new checkouts only.
- **Stuck events:** `/admin` → Webhook processing failures → Reprocess, or Run reconciliation.

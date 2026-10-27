# Customer onboarding

The path a new customer follows from the homepage to live monitoring, and what they see at each step. Steps 1 to 4 happen on the marketing website; steps 5 onwards happen in the customer security portal (see `docs/PORTAL.md`).

1. **Homepage → Pricing.** The customer compares Starter / Growth / Business (prices exclude GST; the total incl. GST is shown under each price) and clicks a plan button.
2. **Sign up or log in.** The chosen plan is carried through (`/signup?plan=GROWTH&cycle=MONTHLY`). Existing users log in and land on the same checkout.
3. **Review & pay (`/checkout`).** The order summary shows price, GST and total, all computed on the server, and whether the plan auto-renews. The customer accepts the Terms/Refund policy and pays in Razorpay Checkout. Only organization **owners and admins** can pay.
4. **Verification of payment.** The page waits until our server has confirmed the payment with Razorpay, then shows the subscription confirmation at `/account`, with an **Open Security Dashboard** button that signs the customer in to the portal by SSO. If confirmation is delayed, the plan activates automatically when the webhook or reconciliation arrives, and Billing shows the pending state.
5. **"Subscription Active · Website Verification Required."** This portal banner stays until a website is verified. The customer uses **Check Your Website Security** (`/check`) to add an HTTPS URL; the plan limit (1 / 5 / 20 websites) is enforced. Returning customers sign in directly at the portal's `/login`.
6. **Verify ownership.** DNS TXT `_trustifyx-verify.<host>` or `/.well-known/trustifyx-verification.txt`, plus the authorization checkbox. See `docs/FIRST_WEBSITE.md` for exact steps and troubleshooting.
7. **Monitoring starts automatically.** "Initial Security Check in Progress" is shown while the first availability and configuration checks run; results appear on the dashboard within minutes. Owners/admins receive an onboarding email when SMTP is configured.
8. **Ongoing.** The portal's Billing Status page shows the plan and usage. Billing management (payments, invoices, plan changes, cancellation, renewal) is self-service at `/account/billing` on the marketing site, reached through "Manage subscription".

## Support playbook

| Customer says | Check |
|---|---|
| "I can't sign in to the portal" | Same email/password as the marketing site. Use **Forgot password** on the portal login page; the reset email needs SMTP. |
| "I paid but nothing changed" | Marketing `/account` → Refresh status. Then `/admin` → subscription row and webhook failures. Run reconciliation. |
| "Website shows Monitoring Paused" | The reason is shown under the status: *Over plan limit*, *Subscription inactive* or *Paused by you*. |
| "Verification fails" | `docs/FIRST_WEBSITE.md` troubleshooting table. |
| "I was charged twice" | `/admin` → payments. Refund the duplicate from the Razorpay dashboard; the refund webhook updates records. |

# Customer onboarding

The path a new customer follows from the homepage to live monitoring, and what they see at each step.

1. **Homepage → Pricing.** The customer compares Starter / Growth / Business (prices exclude GST; the total incl. GST is shown under each price) and clicks a plan button.
2. **Sign up or log in.** The chosen plan is carried through (`/signup?plan=GROWTH&cycle=MONTHLY`). Existing users log in and land on the same checkout.
3. **Review & pay (`/checkout`).** The order summary shows price, GST and total, all computed on the server, and whether the plan auto-renews. The customer accepts the Terms/Refund policy and pays in Razorpay Checkout. Only organization **owners and admins** can pay.
4. **Verification of payment.** The page waits until our server has confirmed the payment with Razorpay, then redirects to Websites. If confirmation is delayed, the plan activates automatically when the webhook or reconciliation arrives, and Billing shows the pending state.
5. **"Subscription Active · Website Verification Required."** This banner stays until a website is verified. The customer adds an HTTPS URL; the plan limit (1 / 5 / 20 websites) is enforced.
6. **Verify ownership.** DNS TXT `_trustifyx-verify.<host>` or `/.well-known/trustifyx-verification.txt`, plus the authorization checkbox. See `docs/FIRST_WEBSITE.md` for exact steps and troubleshooting.
7. **Monitoring starts automatically.** The first availability and configuration checks are queued immediately; results appear on the dashboard within minutes. Owners/admins receive an onboarding email when SMTP is configured.
8. **Ongoing.** Billing shows plan, next billing date, usage, payments and downloadable invoices. Plan changes, cancellation and renewal are self-service.

## Support playbook

| Customer says | Check |
|---|---|
| "I paid but nothing changed" | `/billing` → Refresh status. Then `/admin` → subscription row and webhook failures. Run reconciliation. |
| "Website shows Monitoring Paused" | The reason is shown under the status: *Over plan limit*, *Subscription inactive* or *Paused by you*. |
| "Verification fails" | `docs/FIRST_WEBSITE.md` troubleshooting table. |
| "I was charged twice" | `/admin` → payments. Refund the duplicate from the Razorpay dashboard; the refund webhook updates records. |

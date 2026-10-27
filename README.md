# TrustifyX Secure360

AI-assisted website security monitoring SaaS by **TrustifyX Private Limited**.

Customers sign up, add a website, prove they control its domain (DNS TXT record or a hosted verification file), and Secure360 then continuously and **non-intrusively** monitors it from the outside:

| Check | Default frequency | What is observed |
|---|---|---|
| Availability | every 5 min | HTTP status, redirects, response time (1 retry; downtime confirmed after 2 consecutive failures) |
| TLS certificate | every 6 h | trust chain, hostname match, expiry, issuer, protocol |
| HTTPS enforcement | every 6 h | whether `http://` redirects to `https://` |
| Security headers | every 6 h | HSTS, CSP, X-Content-Type-Options, Referrer-Policy, framing, version disclosure, cookie flags |
| DNS | every 6 h | A/AAAA/CNAME/NS/MX/CAA/SPF/DMARC and changes over time |

Visitors land on a **public marketing site** (`/`), choose a plan (**Starter ₹999 / Growth ₹2,999 / Business ₹7,999** per month + GST), and pay through **Razorpay**. A subscription activates only after payment is verified server-side, and monitoring starts only when the subscription is active **and** the website's ownership is verified and authorized. See [docs/BILLING.md](docs/BILLING.md).

Observations become **findings** (severity, evidence, why it matters, remediation, Open / In Progress / Resolved / False Positive), **incidents** and deduplicated **email alerts**. An optional **AI assistant** explains findings and prioritises work using only sanitised monitoring data. Weekly/monthly **PDF reports** are generated and emailed.

> No JavaScript snippet, agent or active scanning is needed for basic monitoring. Secure360 never exploits, brute-forces or attacks a site, and only checks websites whose ownership has been verified and whose owner confirmed authorization.

## Architecture

```
            ┌────────────── nginx (TLS, rate limits) ──────────────┐
 browser ──►│  web: Next.js 16 (pages + REST API under /api)       │
            └──────┬───────────────────────────┬───────────────────┘
                   │ Prisma                     │ BullMQ (enqueue scans)
              PostgreSQL ◄──────────────────── Redis
                   ▲                            │
                   │ Prisma                     ▼
            worker: BullMQ workers ── scheduler (1/min), availability, config checks,
                                      ownership re-verification, reports, cleanup
                   │
                   └──► customer websites (SSRF-guarded client, egress-firewalled network)
```

One TypeScript codebase, two processes:

| Path | Purpose |
|---|---|
| `src/proxy.ts`, `src/lib/site-routing.ts` | Host-based routing between the two websites (marketing `APP_URL`, portal `PORTAL_URL`) |
| `src/app/(marketing)` | Website 1: public homepage, pricing, legal/policy pages (light theme) |
| `src/app/(checkout)`, `src/app/(account)` | Website 1: checkout (Razorpay), subscription confirmation and billing management |
| `src/app/(auth)` | Website 1: signup / login / invitations |
| `src/app/(portal-auth)` | Website 2: portal login, forgot / reset password |
| `src/app/(app)` | Website 2: the customer security portal (dashboard, Check Website Security, findings, AI, alerts, reports, Billing Status, settings, platform `/admin`) |
| `src/app/sso` | Single sign-on between the websites (short-lived single-use codes) |
| `src/server/billing/` | Plans, Razorpay gateway, signatures, webhooks, entitlements, monitoring gate, reconciliation, invoices, admin |
| `src/app/api/**/route.ts` | REST API (zod validation, CSRF, RBAC, tenant scoping via `src/server/api.ts`) |
| `src/server/security/` | SSRF-safe fetch (`safe-fetch.ts`), IP/URL validation, AES-GCM secrets, rate limiting |
| `src/server/auth/` | argon2id passwords, DB-backed sessions, RBAC |
| `src/server/services/` | Tenant-scoped business logic used by API routes and pages |
| `src/server/websites/` | Domain verification + daily ownership re-verification |
| `src/server/monitoring/` | Availability, TLS, headers, HTTPS, DNS checks, config diff, run orchestration |
| `src/server/findings/` | Rule set (`rules.ts`) and reconciliation engine (`engine.ts`) |
| `src/server/alerts/` | SMTP mailer, recipient preferences, deduplicated dispatch, alert templates |
| `src/server/ai/` | Provider adapters, sanitiser, grounded prompts, CVE output guard |
| `src/server/reports/` | Report aggregation, PDF rendering, scheduled delivery |
| `src/server/integrations/` | Advanced-integration catalog (all "Not Connected" until implemented) |
| `src/worker/index.ts` | BullMQ workers and job schedulers |
| `prisma/` | Schema and migrations |
| `tests/` | Unit tests and PostgreSQL integration tests |
| `deploy/` | nginx config, production compose override, egress firewall |
| `docs/` | Deployment, first website, security, integrations, API |

## Local development

Requirements: Node.js ≥ 20.9 (22/24 recommended), Docker.

```bash
cp .env.example .env
# generate ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# (if port 5432 is taken locally, set POSTGRES_HOST_PORT=55432 and update DATABASE_URL/TEST_DATABASE_URL)

npm install
docker compose up -d postgres redis
npx prisma migrate deploy
npm run dev            # both websites on port 3000
npm run dev:worker     # in a second terminal
```

| Website | Local URL |
|---|---|
| Marketing, pricing, signup, checkout, account | http://localhost:3000 |
| Customer security portal | http://portal.localhost:3000 |

Browsers resolve `*.localhost` to your machine without any hosts-file change. Sign in once on either site; **Open Security Dashboard** carries you across by SSO. See [docs/PORTAL.md](docs/PORTAL.md) for the manual test script.

Open http://localhost:3000, pick a plan and sign up, or go straight to `/signup`. Payments need Razorpay **test** keys (see [docs/BILLING.md](docs/BILLING.md)). Without them, checkout shows "Online payments are not configured"; for local testing you can grant access with `npm run billing:grant -- you@example.com GROWTH 30 "local testing"`. Then open the portal and follow [docs/FIRST_WEBSITE.md](docs/FIRST_WEBSITE.md).

Emails: without `SMTP_HOST`, alerts are recorded in the Alert log with status **Skipped** and not sent. For local testing you can point SMTP at a tool such as Mailpit.

AI: set `AI_PROVIDER=anthropic` and `AI_API_KEY` (default model `claude-opus-5-5`), or `AI_PROVIDER=openai` with `AI_MODEL` (and optionally `AI_BASE_URL` for any OpenAI-compatible endpoint). With `AI_PROVIDER=none` the AI features show "not configured".

## Scripts

| Command | |
|---|---|
| `npm run dev` / `npm run dev:worker` | Development web server / worker (watch mode) |
| `npm run build` / `npm start` | Production build / start of the web app |
| `npm run build:worker` / `npm run start:worker` | Bundle / start the worker (`dist-worker/index.js`) |
| `npm test` | All tests (unit + integration) |
| `npm run test:unit` | Unit tests only (no database needed) |
| `npm run test:integration` | Integration tests against `TEST_DATABASE_URL` |
| `npm run typecheck` | TypeScript check |
| `npm run db:migrate` / `npm run db:deploy` | Create a migration (dev) / apply migrations |
| `npm run admin:promote -- you@trustifyx.com` | Grant TrustifyX platform-operator access (`/admin`) |
| `npm run billing:grant -- owner@x.com GROWTH 30 "reason"` | Complimentary (unpaid, labelled, audited) access, e.g. pre-billing customers |

## Testing

`npm test` runs about 250 tests:

- **SSRF**: private, loopback, link-local, metadata, CGNAT, IPv4-mapped and NAT64/6to4-embedded addresses; DNS answers pointing inside; mixed answer sets; DNS rebinding (connection pinned to the vetted IP); redirect hops to metadata/private/other ports/schemes; hop limits; timeouts; body caps.
- **Domain verification**: TXT record matching (split strings, wrong/partial tokens), verification file (200/404/wrong content), cross-host redirect refusal, authorization confirmation, re-verification failure handling.
- **Tenant isolation**: service layer and real REST route handlers with forged session org, cross-tenant read/update/delete attempts, CSRF/origin rejection, role enforcement.
- **Alerts**: downtime confirmation threshold, single alert per incident, recovery notice, transient blips ignored, per-recipient dedupe under concurrency, preferences, SKIPPED when SMTP is off, TLS-threshold alerts once per certificate.
- **Findings**: rules never describe hardening gaps as attacks, lifecycle (open → resolved → reopened, false positive respected, no auto-resolve when a check failed).
- **AI & reports**: redaction, CVE output guard, cross-tenant prompt isolation, report numbers, PDF rendering, scheduled report idempotency.
- **Two websites / SSO**: host routing, host-bound sessions, the SSO code flow (replay, login CSRF, expiry, open redirect), linked logout, remember-me, password reset, subscription access states, portal dashboard data, cross-organization access.
- **Billing**: Razorpay signature formats, server-side GST pricing, forged/duplicate/out-of-order webhooks, missed-webhook reconciliation, success/failure/renewal/grace/expiry/refund/cancellation, upgrade/downgrade, prepaid idempotency, plan limits, feature gating, monitoring gate, admin controls, and a full journey through the route handlers.

Integration tests use `TEST_DATABASE_URL` (the compose Postgres creates `secure360_test` automatically) and are skipped when it is unset.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (DNS for both domains, Ubuntu VPS, Docker Compose, nginx, TLS, SSO, Razorpay webhook, egress firewall, backups).

## Further documentation

- [docs/PORTAL.md](docs/PORTAL.md): the two websites, unified login / SSO, local testing
- [docs/FIRST_WEBSITE.md](docs/FIRST_WEBSITE.md): connecting the first real website
- [docs/BILLING.md](docs/BILLING.md): Razorpay configuration, webhooks, billing test guide, go-live
- [docs/ONBOARDING.md](docs/ONBOARDING.md): customer journey and support playbook
- [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md): blockers and missing credentials before launch
- [docs/SECURITY.md](docs/SECURITY.md): platform security controls and threat model
- [docs/API.md](docs/API.md): REST API reference
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): design of the Cloudflare, Wazuh, GitHub and ZAP integrations

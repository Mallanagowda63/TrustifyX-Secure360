# REST API

Base path `/api`. JSON in and out. Authentication is via the session cookie set by login/signup. All state-changing requests (POST/PUT/PATCH/DELETE) require:

- header `X-CSRF-Token: <value of the tx_csrf cookie>` (also returned by `GET /api/auth/me`), and
- a same-origin `Origin` header (browsers send it automatically).

Errors: `{ "error": "message", "code": "machine_code", "issues"?: [{ "path", "message" }] }` with status 400 (validation), 401, 403, 404 (also for other tenants' ids), 409, 413, 422, 429 (`Retry-After`), 500/502/503.

Role column: minimum org role (Viewer < Member < Admin < Owner).

## Auth & account

| Method | Path | Role | Body / notes |
|---|---|---|---|
| POST | `/auth/signup` | public | `{ name, email, password, orgName }`, creates user + org (Owner) |
| POST | `/auth/login` | public | `{ email, password }` |
| POST | `/auth/logout` | any | |
| GET | `/auth/me` | any | user, active org, role, orgs, csrfToken |
| POST | `/auth/switch-org` | any | `{ orgId }` (must be a member) |
| GET | `/invitations/:token` | public | invitation preview |
| POST | `/invitations/accept` | public / signed-in | `{ token, name?, password? }` |

## Organization & team

| Method | Path | Role | |
|---|---|---|---|
| GET | `/org` | Viewer | org, members, pending invitations |
| PATCH | `/org` | Owner | `{ name }` |
| POST | `/org/invitations` | Admin | `{ email, role }` returns a one-time `link` |
| DELETE | `/org/invitations/:id` | Admin | revoke |
| PATCH | `/org/members/:id` | Admin | `{ role }` (owner changes by owners only; last owner protected) |
| DELETE | `/org/members/:id` | Admin / self | remove member or leave |
| GET/PUT | `/notification-preferences` | any | per-user, per-org alert preferences |
| GET | `/audit-logs` | Admin | latest 200 events |

## Websites

| Method | Path | Role | |
|---|---|---|---|
| GET | `/websites` | Viewer | list incl. verification instructions |
| POST | `/websites` | Member | `{ url, displayName? }` returns 201 `PENDING_VERIFICATION` |
| GET | `/websites/:id` | Viewer | |
| PATCH | `/websites/:id` | Admin | `{ displayName?, availabilityIntervalSec?, configIntervalSec?, paused? }` |
| DELETE | `/websites/:id` | Admin | deletes history and findings |
| POST | `/websites/:id/verify` | Member | `{ method: "DNS_TXT" or "HTTP_FILE", authorizationConfirmed: true }` returns `{ verified, detail, website }` |
| POST | `/websites/:id/regenerate-token` | Admin | not allowed while connected |
| POST | `/websites/:id/scan` | Member | queue full rescan (cooldown) |
| GET | `/websites/:id/series?range=24h\|7d\|30d` | Viewer | uptime % and avg response per bucket |
| GET | `/websites/:id/checks` | Viewer | last 100 availability checks |
| GET | `/websites/:id/snapshot` | Viewer | latest TLS/headers/HTTPS/DNS observation |
| GET | `/websites/:id/changes` | Viewer | configuration change history |

## Findings, incidents, alerts, dashboard

| Method | Path | Role | |
|---|---|---|---|
| GET | `/findings?status=OPEN,IN_PROGRESS&severity=HIGH&websiteId=` | Viewer | |
| GET | `/findings/:id` | Viewer | |
| PATCH | `/findings/:id` | Member | `{ status, note? }` (note required for FALSE_POSITIVE; RESOLVED triggers a verification scan) |
| POST | `/findings/:id/rescan` | Member | rescan the finding's website |
| GET | `/incidents` | Viewer | |
| GET | `/alerts` | Viewer | delivery log (SENT / FAILED / SKIPPED) |
| GET | `/dashboard` | Viewer | aggregates used by the dashboard |

## Reports

| Method | Path | Role | |
|---|---|---|---|
| GET | `/reports/pdf?period=weekly\|monthly` | Viewer | on-demand PDF for the last 7/30 days |
| GET | `/reports` | Viewer | stored scheduled reports |
| GET | `/reports/:id/pdf` | Viewer | stored report as PDF |

## AI assistant (requires `AI_PROVIDER`)

| Method | Path | Role | |
|---|---|---|---|
| GET | `/ai/status` | any | `{ enabled, provider, model }` |
| POST | `/ai/explain-finding` | Member | `{ findingId }` |
| POST | `/ai/explain-change` | Member | `{ changeId }` |
| POST | `/ai/prioritize` | Member | prioritised recommendations |
| POST | `/ai/ask` | Member | `{ question, websiteId?, history? }` |

Responses: `{ answer, provider, model, generatedAt }`. 503 `ai_disabled` when not configured.

## Billing

| Method | Path | Role | |
|---|---|---|---|
| GET | `/billing/plans` | public | catalog with server-computed GST breakdown |
| GET | `/billing/overview` | Viewer | entitlement, subscription, usage, payments, invoices |
| POST | `/billing/checkout` | Admin | `{ planCode, cycle }` (amount never accepted) returns Razorpay checkout options |
| POST | `/billing/change-plan` | Admin | `{ planCode, cycle }` (upgrade now / downgrade at period end) |
| POST | `/billing/verify` | Admin | Razorpay handler response; signature + provider confirmation |
| POST | `/billing/cancel` | Admin | `{ atPeriodEnd: boolean }` |
| POST | `/billing/renew` | Admin | prepaid / lapsed renewal checkout |
| POST | `/billing/sync` | Admin | pull latest state from Razorpay (rate-limited) |
| GET | `/billing/invoices/:id/pdf` | Viewer | receipt / invoice PDF |
| POST | `/webhooks/razorpay` | Razorpay | HMAC `X-Razorpay-Signature` over raw body; idempotent on `X-Razorpay-Event-Id` |

Plan-gated errors: `402 subscription_required` (no active plan), `403 plan_feature`, `400 plan_limit`.

## Integrations & platform

| Method | Path | Role | |
|---|---|---|---|
| GET | `/integrations` | Viewer | catalog with status (`NOT_CONNECTED`) |
| GET | `/admin/organizations` | platform admin | tenant list with counts only |
| GET | `/admin/billing` | platform admin | subscriptions, payments, failures, webhook failures, onboarding, audit |
| PATCH | `/admin/plans/:code` | platform admin | `{ confirmCode, patch }` catalog edit (new checkouts only) |
| POST | `/admin/billing/grant` / `/revoke` | platform admin | complimentary access (no payment records) |
| POST | `/admin/billing/reconcile` | platform admin | run billing reconciliation |
| POST | `/admin/billing/webhooks/:id` | platform admin | reprocess a stored verified event |
| GET | `/health` | public | `{ status, database, redis }` |

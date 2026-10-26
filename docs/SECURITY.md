# Platform security

How Secure360 protects its customers, and how it avoids becoming an attack tool itself. File references point at the implementing code.

## Threat model (main risks)

| Risk | Mitigation |
|---|---|
| Customer A reads or changes customer B's data | Tenant scoping on every query, role checks server-side |
| The monitor is abused to reach internal networks / cloud metadata (SSRF) | SSRF-safe client, DNS pinning, redirect re-validation, network egress firewall |
| Monitoring sites the customer does not own | Mandatory ownership verification + authorization confirmation + daily re-verification |
| Account takeover | argon2id, rate limits, lockout, secure session cookies, CSRF protection |
| Leaking customer secrets to the AI provider | Data minimisation and redaction before any AI call |
| AI inventing threats or taking actions | Grounded prompt, output guard, no tools / no execution capability |

## Authentication and sessions (`src/server/auth/`)

- Passwords: argon2id (m=19 MiB, t=2, p=1, OWASP), minimum 12 characters, common-password and email-name checks. Login timing is equalised for unknown accounts.
- Sessions: 256-bit random tokens; only the SHA-256 hash is stored. Cookie `__Host-tx_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. Default lifetime 7 days (`SESSION_TTL_HOURS`).
- CSRF: every state-changing request must carry `X-CSRF-Token` matching the session's token (double-submit cookie `__Host-tx_csrf`, `SameSite=Strict`) **and** pass an `Origin` / `Sec-Fetch-Site` check (`src/server/api.ts`).
- Rate limiting (Redis, in-memory fallback): signup 5/h/IP, login 30/15 min/IP plus 10/15 min/account, invitations, verification 10/h/website, AI 60/h/org, manual rescans with a cooldown. nginx adds per-IP limits.
- Lockout: 10 failed logins lock the account for 15 minutes.

## Authorization and tenant isolation

- Roles per organization: Owner, Admin, Member, Viewer (`src/server/auth/rbac.ts`). The permission matrix is enforced in `authedRoute()` and again in the service layer (`assertCan`).
- The tenant (`orgId`) always comes from the server-side session membership, never from request input. The session's active org is re-validated against `Membership` on every request.
- Every lookup by id includes `orgId` (`getWebsiteForOrg`, `getFinding`, …); a foreign id returns **404**, not 403, to avoid enumeration.
- Platform admins (TrustifyX operators) see tenant counts only, not customer monitoring data.
- Covered by `tests/integration/tenant-isolation.test.ts` (including a forged session org) and `tests/integration/ai-reports.test.ts` (AI prompts never contain other tenants' data).

## Website onboarding controls

- `normalizeWebsiteUrl` (`src/server/security/url.ts`): HTTPS only, port 443 only, no credentials, no IP literals (incl. decimal/hex/octal forms), no reserved/internal suffixes, must sit under a public suffix (tldts).
- Ownership proof via DNS TXT at `_trustifyx-verify.<host>` or `/.well-known/trustifyx-verification.txt` (same-host redirects only), with a 256-bit random per-site token.
- Monitoring only when `status = CONNECTED` **and** `verifiedAt` **and** `authorizationConfirmedAt` are set (`isMonitorable`, enforced in the scheduler SQL and again inside each job).
- Daily re-verification; 3 consecutive failures stop monitoring (`src/server/websites/reverify.ts`).

## SSRF and outbound network protections (`src/server/security/safe-fetch.ts`)

1. Only `http`/`https`, only ports 80/443, no credentials, no single-label hosts.
2. The hostname is resolved once; if **any** returned address is not public unicast, the request is refused. Blocked: RFC1918, loopback, link-local (169.254.0.0/16 incl. cloud metadata), CGNAT, ULA, multicast, reserved, documentation, IPv4-mapped/NAT64/6to4/Teredo forms, and explicit metadata IPs (`src/server/security/ip.ts`).
3. The socket connects to that vetted IP via a pinned `lookup`, so a second DNS answer cannot redirect it (DNS rebinding). The connected remote address is checked again.
4. Redirects are followed manually; every hop is re-validated and re-resolved. Max 5 hops.
5. Hard timeout (10 s), response-size cap, no keep-alive or connection reuse, identifying User-Agent.
6. Network layer: containers egress through a dedicated bridge whose private/metadata destinations are rejected by `deploy/egress-firewall.sh`; Postgres/Redis sit on a gateway-less internal network in production.
7. `MONITOR_ALLOW_PRIVATE_TARGETS` exists for local testing only; the app refuses to start with it in production.

Checks are passive: plain GET requests, TLS handshakes and DNS lookups. No payloads, fuzzing, port scanning, brute force or exploitation.

## Queue and resource limits

- One queued job per website per check type (deterministic job ids), so a site can never be flooded.
- Worker concurrency `MONITOR_CONCURRENCY` (default 10) and `MONITOR_CONFIG_CONCURRENCY` (3), with a limiter of 30 config checks per minute.
- Minimum availability interval `MONITOR_MIN_INTERVAL_SEC` (60 s); plan limit `MAX_WEBSITES_PER_ORG`.
- Request bodies are capped at 64 KB; JSON validated with zod (`.strict()` where applicable).

## Secrets and data protection

- All secrets come from environment variables; `.env` is git-ignored and should be `chmod 600`.
- Integration credentials are encrypted with AES-256-GCM (`ENCRYPTION_KEY`, random IV, authenticated) and never returned by APIs.
- Cookie values from monitored sites are never stored (names and flags only).
- Security headers on the dashboard: HSTS, CSP (`frame-ancestors 'none'`, `object-src 'none'`), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP.
- Containers run as the unprivileged `node` user.

## AI safeguards (`src/server/ai/`)

- Only the monitoring observations needed for the question are sent: hostnames, findings with evidence, check summaries, incidents, config changes. Never users, emails, password hashes, session/verification tokens, integration credentials, certificate serials or IPs.
- `sanitize.ts` additionally redacts emails, JWTs, API keys, private keys, long hex/base64 strings and credential-looking query parameters.
- The system prompt restricts answers to the provided data, forbids invented attacks/CVEs/scan results, states that missing headers are not attacks, and treats monitored content as untrusted (prompt-injection resistant).
- `guardOutput` removes any CVE identifier not present in the data.
- The AI has no tools and no write access; it cannot change infrastructure. Every AI call is rate-limited, logged (`AiInteraction`) and audited.
- With the Anthropic provider, Claude API server-side refusal fallbacks (`fallbacks: "default"`) are enabled for supported models.

## Audit logging

`AuditLog` records sign-ups, logins, failed logins, lockouts, website create/verify/verify-failed/pause/resume/delete/token-regeneration/scan requests, ownership loss, finding status changes, team changes, notification changes, report downloads and AI usage, with user, IP and metadata. Org admins can view it under **Audit Log**.

## Reporting a vulnerability

Report security issues in Secure360 itself to security@trustifyx.com (configure this mailbox before launch).

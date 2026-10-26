# Advanced integrations: design

Status: **designed, not implemented**. The dashboard lists all four as *Not Connected* and shows no counts or events for them (`src/server/integrations/catalog.ts`). They are deliberately separate from basic URL monitoring: basic monitoring needs only domain verification, while each integration needs explicit customer credentials, consent and its own data pipeline.

## Shared framework (already in place)

- `Integration` table: one row per `(orgId, type)`, `status` (`NOT_CONNECTED` | `CONNECTED` | `ERROR`), `encryptedCredentials` (AES-256-GCM via `encryptSecret`), `config` (JSON), `lastSyncAt`, `lastError`.
- Permissions: `integration.read` (Viewer+), `integration.manage` (Admin+).
- To implement a connector:
  1. `POST /api/integrations/:type/connect`: validate credentials with a read-only test call, store encrypted, audit `integration.connected`.
  2. `DELETE /api/integrations/:type`: wipe credentials, audit.
  3. A BullMQ queue `integration-sync` with a per-org job id; the worker decrypts credentials in memory only.
  4. Store events in a dedicated table (`IntegrationEvent`: orgId, type, externalId unique, occurredAt, category, severity, summary, raw JSON capped in size) with retention.
  5. Show data only from that table, labelled with its source and last sync time. Never synthesise or extrapolate counts.
  6. AI context may include aggregated integration data only after sanitisation, labelled by source.

## Cloudflare WAF

- **Auth:** customer-created API token scoped to `Zone:Read`, `Analytics:Read` (and `Firewall Services:Read`) for selected zones.
- **Mapping:** zone name must equal (or be the registrable domain of) a *verified* website in the same org.
- **Data:** GraphQL Analytics API `firewallEventsAdaptive` (action, rule id, source, country, path, timestamp), sampled. Display as "Cloudflare-reported events" with Cloudflare's own action labels (block/challenge/log). Plus zone settings (SSL mode, security level, min TLS) as configuration observations feeding the change log.
- **Sync:** every 15 min, incremental by `datetime_gt`.

## Wazuh

- **Auth:** Wazuh manager API URL + read-only API user (RBAC role limited to `alerts:read`/`agents:read`), optional CA pinning. The manager URL is customer infrastructure, so connector requests go through `safe-fetch` with the same public-address rules. Self-hosted private managers instead push alerts to a per-org HTTPS ingest endpoint with an HMAC-signed payload.
- **Data:** alerts with `rule.level >= 7` (configurable), FIM events, vulnerability-detector results as reported by Wazuh (CVE ids then come from Wazuh data, never from the AI).
- **Sync:** pull every 5 min by `timestamp`, or push via ingest.

## GitHub

- **Auth:** GitHub App (not personal tokens) installed by the customer on selected repositories; permissions `security_events: read`, `dependabot_alerts: read`, `secret_scanning_alerts: read`, `administration: read` (branch protection). Tokens are short-lived installation tokens.
- **Data:** open Dependabot, code-scanning and secret-scanning alerts (counts by severity, links to GitHub), and branch protection on the default branch.
- **Sync:** webhooks (`dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert`) plus a daily reconciliation.

## OWASP ZAP baseline (authorized assessment)

- **Scope:** ZAP *baseline* (spider + passive rules, no active attack payloads) against a verified website only.
- **Authorization:** separate explicit consent per run (who, when, target, time window) stored in the audit log, in addition to domain verification. Runs only on demand, max once per 24 h per site.
- **Isolation:** scans run in a separate, ephemeral container on its own network with the egress firewall, a time limit (e.g. 10 min), and request-rate limits. Never inside the main worker.
- **Data:** ZAP alerts (risk, confidence, URL, evidence) imported as findings in a separate `zap.*` rule namespace, clearly labelled as ZAP results.

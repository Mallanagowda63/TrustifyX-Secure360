# Deploying Secure360 on an Ubuntu VPS

Target: Ubuntu 22.04/24.04 LTS, 2 vCPU / 4 GB RAM minimum (comfortably monitors several hundred websites at 5-minute intervals). The stack runs in Docker Compose behind nginx on the host.

One deployment serves **two websites** from the same containers (see `docs/PORTAL.md`):

| Website | Example domain | Variable |
|---|---|---|
| Marketing, pricing, signup, checkout, account/billing | `secure360.trustifyx.in` | `APP_URL` |
| Customer security portal (login-only) | `portal.trustifyx.in` | `PORTAL_URL` |

Nothing in this guide is run automatically. Deploying to the live servers is a manual, approved step.

## 0. DNS

Create these records at the DNS provider for `trustifyx.in`, pointing at the VPS:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `secure360` | `<VPS IPv4>` | 300 |
| A | `portal` | `<VPS IPv4>` | 300 |
| AAAA | `secure360`, `portal` | `<VPS IPv6>` (only if the server has IPv6) | 300 |
| CAA | `@` (or each name) | `0 issue "letsencrypt.org"` | 3600 |

Check with `dig +short secure360.trustifyx.in portal.trustifyx.in` before requesting certificates. Optionally add a TrustifyX SPF/DKIM/DMARC configuration for the domain used in `MAIL_FROM`, so password-reset and alert emails are delivered.

## 1. Prepare the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install ca-certificates curl git nginx certbot python3-certbot-nginx ufw iptables-persistent unattended-upgrades

# Docker Engine + compose plugin (official repository)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in

# Firewall: only SSH and HTTP(S) inbound
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Harden SSH (`PasswordAuthentication no`, key-only login) and enable unattended security upgrades (`sudo dpkg-reconfigure -plow unattended-upgrades`).

## 2. Get the code and configure secrets

```bash
sudo mkdir -p /opt/secure360 && sudo chown $USER /opt/secure360
git clone <your-repo-url> /opt/secure360 && cd /opt/secure360
cp .env.example .env
chmod 600 .env
```

Edit `.env`. Production values:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://secure360.trustifyx.in`: the marketing website (HTTPS enables `__Host-` secure cookies) |
| `PORTAL_URL` | `https://portal.trustifyx.in`: the customer portal. It must be a different hostname with the same scheme, or the app refuses to start |
| `SESSION_TTL_HOURS`, `SESSION_SHORT_TTL_HOURS` | session lifetime with / without "Keep me signed in" (defaults 168 / 12) |
| `POSTGRES_PASSWORD` | long random value: `openssl rand -base64 32` |
| `REDIS_PASSWORD` | long random value (used by `deploy/docker-compose.prod.yml`) |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (back it up: losing it makes stored integration credentials unreadable) |
| `TRUST_PROXY` | `true` (set automatically by the prod override) |
| `ALLOW_SIGNUP` | `true` for public self-service, `false` for invite-only |
| `SMTP_*`, `MAIL_FROM` | your transactional email provider (SES, Postmark, SendGrid, Zoho, …) |
| `DNS_SERVERS` | `1.1.1.1,8.8.8.8,9.9.9.9` (public resolvers for verification and DNS monitoring) |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | optional; `anthropic` uses `claude-opus-5-5` by default |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay keys (test first, live after KYC). See `docs/BILLING.md` |
| `BILLING_MODE` | `recurring` (Razorpay Subscriptions) or `prepaid` |
| `BILLING_SELLER_NAME`, `BILLING_SELLER_ADDRESS`, `BILLING_SELLER_GSTIN` | printed on invoices (accountant review required) |
| `SUPPORT_EMAIL`, `SECURITY_EMAIL` | shown on the website, footer and `/.well-known/security.txt` |
| `MONITOR_ALLOW_PRIVATE_TARGETS` | never set in production (the app refuses to start if it is) |

`DATABASE_URL` and `REDIS_URL` are overridden inside the containers by the compose files; you don't need to change them in `.env`.

## 3. Build and start

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --profile full up -d --build
docker compose ps
curl -s http://127.0.0.1:3000/api/health     # {"status":"ok","database":true,"redis":true}
```

The `migrate` service applies Prisma migrations before `web` and `worker` start. In production, Postgres and Redis are not published to the host, and the `internal` network has no gateway.

## 4. Restrict outbound traffic from the containers

The application already refuses to contact private, loopback, link-local and cloud-metadata addresses. Add the network-level layer as well:

```bash
sudo ./deploy/egress-firewall.sh apply
sudo netfilter-persistent save
```

Re-run `apply` after recreating the Docker networks (`docker compose down` removes them). To verify from inside the worker container:

```bash
docker compose exec worker node -e "fetch('http://169.254.169.254/').then(()=>console.log('REACHABLE - check firewall')).catch(e=>console.log('blocked:', e.cause?.code))"
```

## 5. nginx and TLS

`deploy/nginx/secure360.conf` has one HTTP→HTTPS block and one HTTPS server block per website. Both proxy to the same app on `127.0.0.1:3000` and **must preserve the `Host` header**, because the app selects the website from it. The portal block adds `X-Robots-Tag: noindex` and refuses `/api/webhooks/*`.

```bash
sudo cp deploy/nginx/secure360-proxy.conf deploy/nginx/secure360-tls.conf /etc/nginx/snippets/
sudo cp deploy/nginx/secure360.conf /etc/nginx/sites-available/
sudo sed -i 's/secure360.example.com/secure360.trustifyx.in/g; s/portal.example.com/portal.trustifyx.in/g' /etc/nginx/sites-available/secure360.conf
sudo rm -f /etc/nginx/sites-enabled/default

# One certificate covering both names (issue it before enabling the HTTPS blocks):
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d secure360.trustifyx.in -d portal.trustifyx.in
#   (if port 80 is not served yet: sudo certbot certonly --standalone -d ... with nginx stopped)

sudo ln -s /etc/nginx/sites-available/secure360.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://secure360.trustifyx.in/ | head -1
curl -sI https://portal.trustifyx.in/login | head -1
```

Certbot installs a renewal timer automatically (`systemctl list-timers | grep certbot`). Add a deploy hook so nginx picks up renewed certificates: `echo 'systemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/nginx.sh && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/nginx.sh`.

### Authentication callbacks (SSO)

No external identity provider is involved, so nothing has to be registered anywhere. The SSO endpoints are served on **both** hosts and only redirect between the two configured URLs:

| Endpoint | Host | Purpose |
|---|---|---|
| `/sso/begin` | target site | sets the `state` cookie, redirects to the other site's `/sso/authorize` |
| `/sso/authorize` | source site (has the session) | issues a 60-second single-use code, redirects to `/sso/callback` |
| `/sso/callback` | target site | checks state, redeems the code, creates a new session |
| `/sso/open?target=portal\|marketing&next=/path` | either | used by the "Open Security Dashboard" and "Manage subscription" buttons |

Requirements: `APP_URL`/`PORTAL_URL` exactly match the public URLs (scheme and host, no trailing path); nginx passes `Host`; HTTPS on both names. Password-reset emails link to `PORTAL_URL/reset-password`.

## 6. Razorpay webhook

In the Razorpay dashboard, add a webhook to `https://secure360.trustifyx.in/api/webhooks/razorpay` (the **marketing** domain; the portal refuses webhook paths) with the events listed in `docs/BILLING.md`, and put its secret in `RAZORPAY_WEBHOOK_SECRET`. The worker reconciles billing every 10 minutes, so short outages of the webhook are recovered automatically.

## 7. First administrator

1. Open `https://secure360.trustifyx.in/signup` and create the TrustifyX account.
2. Grant platform-operator access (tenant overview at `GET /api/admin/organizations`, counts only):
   ```bash
   docker compose exec worker npx tsx scripts/promote-admin.ts you@trustifyx.com
   ```
3. Set `ALLOW_SIGNUP=false` if customers should only join by invitation, then `docker compose ... up -d`.
4. **Upgrading an existing installation to the billing release:** migrations are additive (the `migrate` service applies them). Existing organizations have no subscription, so their monitoring pauses until they subscribe. To keep pre-billing customers running, grant complimentary access first:
   ```bash
   docker compose exec worker npx tsx scripts/grant-complimentary.ts owner@customer.com GROWTH 90 "Pre-billing customer"
   ```
   Take a `pg_dump` before upgrading (see Backups).

## 8. Verify the deployment

Run through `docs/PRODUCTION_CHECKLIST.md` → "Two-website verification" before announcing the portal. Use Razorpay **test** keys first. A test-mode payment proves the integration, not live payments.

## 9. Operations

**Logs:** `docker compose logs -f web worker`. The worker logs scheduling and failed jobs.

**Backups (daily, keep 14):**

```bash
sudo tee /etc/cron.daily/secure360-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
mkdir -p /var/backups/secure360
cd /opt/secure360
docker compose exec -T postgres pg_dump -U trustifyx -Fc secure360 > /var/backups/secure360/secure360-$(date +%F).dump
find /var/backups/secure360 -name '*.dump' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/secure360-backup
```

Copy backups off the server (object storage) and store `ENCRYPTION_KEY` separately from them. Restore with `pg_restore -U trustifyx -d secure360 --clean <file>`.

**Updates:**

```bash
cd /opt/secure360 && git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --profile full up -d --build
sudo ./deploy/egress-firewall.sh apply
```

**Scaling:** increase `MONITOR_CONCURRENCY` (availability) and `MONITOR_CONFIG_CONCURRENCY`, or run more worker replicas (`docker compose ... up -d --scale worker=2`). Jobs are deduplicated per website, so replicas never double-check a site.

**Health monitoring:** point an external uptime monitor at `https://secure360.trustifyx.in/api/health` and `https://portal.trustifyx.in/login`.

## Data retention

Availability checks and configuration snapshots older than 400 days, expired sessions and expired invitations are deleted daily at 03:30 UTC (`cleanup` job in `src/worker/index.ts`).

# Deploying Secure360 on an Ubuntu VPS

Target: Ubuntu 22.04/24.04 LTS, 2 vCPU / 4 GB RAM minimum (comfortably monitors several hundred websites at 5-minute intervals). The stack runs in Docker Compose behind nginx on the host.

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
| `APP_URL` | `https://app.yourdomain.com` (HTTPS enables `__Host-` secure cookies) |
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

```bash
sudo cp deploy/nginx/secure360-proxy.conf /etc/nginx/snippets/
sudo cp deploy/nginx/secure360.conf /etc/nginx/sites-available/
sudo sed -i 's/app.example.com/app.yourdomain.com/g' /etc/nginx/sites-available/secure360.conf
sudo ln -s /etc/nginx/sites-available/secure360.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
# First issue the certificate (certbot temporarily edits the config):
sudo certbot certonly --nginx -d app.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

Certbot installs a renewal timer automatically (`systemctl list-timers | grep certbot`).

## 6. Razorpay webhook

In the Razorpay dashboard, add a webhook to `https://app.yourdomain.com/api/webhooks/razorpay` with the events listed in `docs/BILLING.md`, and put its secret in `RAZORPAY_WEBHOOK_SECRET`. The worker reconciles billing every 10 minutes, so short outages of the webhook are recovered automatically.

## 7. First administrator

1. Open `https://app.yourdomain.com/signup` and create the TrustifyX account.
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

## 8. Operations

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

**Health monitoring:** point an external uptime monitor at `https://app.yourdomain.com/api/health`.

## Data retention

Availability checks and configuration snapshots older than 400 days, expired sessions and expired invitations are deleted daily at 03:30 UTC (`cleanup` job in `src/worker/index.ts`).

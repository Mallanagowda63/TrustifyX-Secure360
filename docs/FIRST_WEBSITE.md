# Connecting the first real website

This walks a customer (or you, for TrustifyX's own site) through connecting a website end to end. It takes about 5 minutes plus DNS propagation time.

## Before you start

- Your organization needs an **active plan** (choose one on the homepage pricing section or under **Billing**). The plan sets how many websites you can connect.
- The website must be served over **HTTPS** on the standard port (443) and reachable from the internet.
- You need access to **either** the domain's DNS settings **or** the web server's files.
- You must own the website or have the owner's authorization to monitor it.

## 1. Add the website

1. Sign in and open **Websites**.
2. Enter the URL, e.g. `https://www.yourcompany.com`, and optionally a display name. Click **Add website**.
3. The site appears with status **Pending Verification**, and the verification instructions open.

The URL is validated server-side: IP addresses, internal names (`localhost`, `*.internal`, `*.local`), credentials in URLs and non-standard ports are rejected.

## 2. Prove ownership (choose one)

### Option A: DNS TXT record (recommended)

At your DNS provider, create:

| Type | Name / Host | Value |
|---|---|---|
| TXT | `_trustifyx-verify.www.yourcompany.com` | `trustifyx-site-verification=<your token>` |

Copy the exact name and value from the dashboard (each website has its own random token). Many providers append the root domain automatically. In that case enter only `_trustifyx-verify.www` (or `_trustifyx-verify` for an apex domain).

Check propagation: `dig +short TXT _trustifyx-verify.www.yourcompany.com @1.1.1.1`

### Option B: Verification file

Publish a plain-text file so that this URL returns HTTP 200:

```
https://www.yourcompany.com/.well-known/trustifyx-verification.txt
```

with the content `trustifyx-site-verification=<your token>` on its own line. Redirects to another hostname are not accepted.

nginx example:

```nginx
location = /.well-known/trustifyx-verification.txt {
    default_type text/plain;
    return 200 "trustifyx-site-verification=<your token>\n";
}
```

## 3. Verify and authorize

1. Tick **"I confirm that I own this website or am authorized…"**. Monitoring is never enabled without this confirmation; it is recorded with your user and timestamp in the audit log.
2. Click **Verify ownership**.
   - Success: status becomes **Connected** and the first availability and configuration checks are queued immediately.
   - Failure: status becomes **Verification Failed**, and the exact reason is shown (record not found, wrong value, HTTP 404, …). Fix it and click Verify again (up to 10 attempts per hour).

**Keep the TXT record or file in place.** Ownership is re-checked daily. After 3 consecutive failed re-checks, monitoring stops and the status returns to Verification Failed.

## 4. What happens next

| When | What you see |
|---|---|
| ~1 minute | First availability check: state **Online**, response time, HTTP status |
| ~1-2 minutes | First configuration check: TLS certificate, security headers, HTTPS redirect and DNS details on the website page, plus any **findings** |
| every 5 minutes | Availability checks; uptime and response-time charts fill in |
| every 6 hours | Configuration checks; changes appear under **Configuration changes** |

Adjust intervals, pause monitoring or remove the site from the website page (**Settings**, **Pause monitoring**, **Remove**; admins only).

## 5. Alerts

Each member chooses in **Settings → Notifications**:

- downtime confirmed / recovered (downtime is confirmed only after 2 consecutive failed checks, each with one retry),
- TLS expiry warnings at 30, 14, 7, 3 and 1 days (once per certificate per threshold),
- new / resolved findings at or above a chosen severity (default Medium),
- weekly / monthly PDF reports.

If SMTP is not configured on the server, alerts are listed under **Incidents & Alerts** with status *Skipped*.

## 6. Fixing findings

Open **Findings**, select one, and read the evidence, why it matters and the recommended fix. After deploying a fix, click **Rescan website to verify fix**, or mark it **Resolved**, which also triggers a verification scan. A finding that is still observed reopens automatically. If a finding does not apply (for example, intentional framing), mark it **False Positive** with a reason; later scans respect that decision.

## 7. Invite your team

**Settings → Team → Invite a teammate**: choose Admin, Member or Viewer. The invite link is emailed when SMTP is configured and is always shown once to the inviter.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No TXT record found" | Wait for propagation; check the name isn't doubled (`…yourcompany.com.yourcompany.com`) |
| "returned HTTP 403/404" | Check the file path and that your WAF/CDN does not block the monitoring user agent `TrustifyX-Secure360-Monitor/1.0` |
| "resolves to a non-public address" | The domain points to a private IP; only publicly reachable sites can be monitored |
| Site shows Offline but works for you | Check whether a firewall/WAF blocks the monitor's IP or user agent; allowlist the Secure360 server IP |

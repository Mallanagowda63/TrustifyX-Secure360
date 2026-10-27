# Two websites: marketing site and customer security portal

TrustifyX Secure360 is served as two websites from **one application, one database and one user table**:

| | Website 1: marketing & purchase | Website 2: customer security portal |
|---|---|---|
| Production example | `https://secure360.trustifyx.in` | `https://portal.trustifyx.in` |
| Local | http://localhost:3000 | http://portal.localhost:3000 |
| Variable | `APP_URL` | `PORTAL_URL` |
| Pages | Homepage, pricing, signup, login, checkout (Razorpay), payment confirmation, `/account` (subscription status), `/account/billing` (billing management), legal pages | Login (`/login`), forgot/reset password, dashboard (`/`), Check Your Website Security (`/check`), My Websites, findings, AI assistant, alerts, reports, Billing Status, settings |
| Not available | Monitoring pages: they redirect to the portal | Signup, pricing and checkout: they redirect to the marketing site's pricing section |

The app tells the two apart by the `Host` header (`src/proxy.ts` → `src/lib/site-routing.ts`). Unknown paths on the portal return 404, so marketing content is never served under the portal hostname.

## Authentication model

- **One identity.** Both websites use the same `User`, `Organization`, `Membership` and `Subscription` tables. There is no second user database and no account sync.
- **Separate, host-bound sessions.** Each website sets its own host-only `HttpOnly` cookie (`__Host-` prefixed and `Secure` over HTTPS, `SameSite=Lax`). A session row records which site it belongs to (`Session.site`). A marketing session token is refused by the portal, and the reverse is also true.
- **Single sign-on with a short-lived code.** "Open Security Dashboard" uses an OAuth-style authorization-code flow between the two hosts:
  1. The portal's `GET /sso/begin?next=/check` creates a random `state` and stores it in a short-lived `HttpOnly` cookie scoped to `/sso`. It then redirects to the marketing site's `/sso/authorize?state=…&next=…`.
  2. The marketing site checks its own session. It issues a **single-use code** that lives for 60 seconds, is bound to `sha256(state)`, and is stored only as a hash. It then redirects to the portal's `/sso/callback?code=…&state=…`.
  3. The portal checks that `state` matches its cookie, then redeems the code atomically. It creates a **fresh portal session** (new token, session rotation) and redirects to the validated `next` path.

  The session token never appears in a URL, `localStorage` or `sessionStorage`. A code is useless without the matching state cookie, which blocks login CSRF.
- **Same flow in the other direction.** "Manage subscription" in the portal opens `/sso/open?target=marketing&next=/account/billing`.
- **Linked logout.** Sessions created through SSO share an `ssoGroupId`, so logging out of one site ends the linked session on the other.
- **Remember me.** If it is unticked on the portal login, the cookie lasts only for the browser session, and the server-side lifetime is `SESSION_SHORT_TTL_HOURS` (default 12).
- **Forgot password.** The reset link is single-use, valid for 30 minutes, stored hashed and rate-limited. The response is the same whether or not the account exists. A successful reset signs the user out everywhere.
- **CSRF.** State-changing API calls must carry an `Origin` equal to the **same** website's origin, plus the `X-CSRF-Token` double-submit header. The marketing site cannot post to the portal's API, and the portal cannot post to the marketing site's API.
- **Redirect destinations** (`next=`) must be relative paths that belong to the target website (`safeNextPath`). Absolute URLs, `//host`, `/\host`, API paths and the other site's pages are replaced with the default page.

## Subscription access in the portal

The portal reads the subscription state from the backend. It never relies on a payment-success screen.

| State | Portal shows |
|---|---|
| Active / complimentary / cancelling (until period end) | Full access. If no website is verified yet: "Subscription Active · Website Verification Required" |
| Grace period after a failed renewal | Access with a warning banner |
| Payment Confirmation Pending | Banner; monitoring starts as soon as Razorpay confirms (webhook, verify call or 10-minute reconciliation) |
| Subscription Required (no plan, expired, halted) | Banner with **View Pricing Plans**, which links to the marketing site; adding websites returns HTTP 402 |

The **Security Posture Score** starts at 100 and subtracts a weight for each open finding (Critical 40, High 20, Medium 10, Low 4, Info 1), with a floor of 0. It appears only after a configuration check has run, and it excludes findings marked as false positives. The methodology and its limits are shown on the dashboard. It describes configuration hygiene from passive checks; it is not a penetration test or a guarantee.

## Running both websites locally

Edge, Chrome and Firefox resolve any `*.localhost` name to `127.0.0.1`, so no hosts-file change is needed.

```bash
docker compose up -d postgres redis
npx prisma migrate deploy
npm run dev            # serves BOTH websites on port 3000
npm run dev:worker     # second terminal
```

`.env` must contain:

```
APP_URL=http://localhost:3000
PORTAL_URL=http://portal.localhost:3000
```

The app refuses to start if both URLs share a hostname, or if one uses `https` and the other doesn't.

### Manual test script

1. **Marketing:** open http://localhost:3000. Pick a plan, sign up, then complete checkout. Razorpay test keys are required; without them, grant access with `npm run billing:grant -- you@example.com GROWTH 30 "local testing"`. You land on `/account`, which shows the subscription confirmation.
2. **SSO:** click **Open Security Dashboard**. You arrive at http://portal.localhost:3000 already signed in, without a second login. Check in DevTools → Application → Cookies: `portal.localhost` has its own `tx_session`, and no token appears in the address bar or Local Storage.
3. **Portal login:** in a private window, open http://portal.localhost:3000. You are sent to `/login`, which has no signup button; "Explore Plans" goes to the marketing pricing section. Sign in with the same email and password.
4. **Check Your Website Security:** enter an HTTPS website you control and verify ownership by DNS TXT record or file. "Initial Security Check in Progress" appears, and the results follow within a minute or two (the worker must be running).
5. **Routing:** http://portal.localhost:3000/signup should go to the marketing pricing section. http://localhost:3000/dashboard should go to the portal.
6. **Logout:** sign out on the portal, then reload http://localhost:3000/account. If you reached the portal through SSO, you are signed out there too.
7. **Forgot password:** use http://portal.localhost:3000/forgot-password. Without `SMTP_HOST`, the email is recorded but not sent.

### Automated tests

`npm test` includes the following (no browser needed):

- `tests/unit/portal-unit.test.ts`: host routing, redirect-destination validation, the cross-site redirect route, posture score, status indicators.
- `tests/integration/portal.test.ts`, against the real route handlers and Postgres:
  - shared identity and host-bound sessions;
  - the full SSO flow, code replay, login CSRF, expired codes and open redirects;
  - linked logout, remember-me, expired sessions;
  - no signup on the portal, cross-site form posts blocked;
  - forgot/reset password;
  - subscription access states, dashboard data;
  - unauthenticated and cross-organization access, unpaid customers blocked.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Portal redirects to login after "Open Security Dashboard" | The `PORTAL_URL` host doesn't match the address in the browser (for example `127.0.0.1` vs `portal.localhost`). Use exactly the configured hostnames. |
| Portal login page opened with `?error=sso` | The code expired (more than 60 seconds), was already used, or the state cookie was missing, for example because cookies are blocked. Click the button again. |
| HTTP 403 `csrf` ("Cross-origin request blocked") on API calls | A request was sent from the other website's origin, or a proxy stripped the `Origin`/`Host` headers. nginx must pass `Host $host`. |

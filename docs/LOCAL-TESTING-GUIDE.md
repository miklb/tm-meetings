# Local Testing Guide — Keyword Notification System

This guide outlines step-by-step instructions for testing the keyword notification system locally on your development machine using mock endpoints and logs.

---

## Prerequisites

1. **Main SQLite Database**: Ensure the historical meeting database has been built:
   ```bash
   npm run build-db
   ```
   This generates `data/meetings.db`.

2. **Local D1 Database Setup**: Initialize the D1 local state and apply the migrations:
   ```bash
   cd site
   npx wrangler d1 migrations apply tampa-meetings-notifications --local
   ```
   This compiles migrations inside the `site/.wrangler` directory.

3. **Local Dev Vars**: Copy `.dev.vars.example` to `site/.dev.vars` (next to where you run wrangler). At minimum set:
   ```ini
   ENVIRONMENT="development"
   WEBHOOK_SECRET="any-local-secret"
   ```
   The API fails closed: without `ENVIRONMENT="development"`, missing secrets return errors instead of enabling mock/dev behavior, and `/api/notify` always refuses requests when `WEBHOOK_SECRET` is unset.

---

## 1. Seed a Local Test Supporter

Since the system runs in `SUPPORTERS_ONLY` registration mode during beta, you must add your test email to the D1 database to authorize subscription and management.

Run the following SQL commands to seed a supporter:
```bash
# From the site/ directory — root and site/ have separate .wrangler local D1
# states, and the dev server reads the one under site/
cd site
npx wrangler d1 execute tampa-meetings-notifications --local --command="INSERT OR REPLACE INTO supporters (email, tier, source, active_until) VALUES ('supporter@tampamonitor.com', 'supporter', 'manual', NULL);"
```

---

## 2. Run the Development Server

Wrangler uses the `site/wrangler.toml` file to run. Launch the server from the `site/` folder:

```bash
cd site
npx wrangler pages dev --compatibility-date=2024-03-01 --port=8789 --show-interactive-dev-session=false
```

Keep this running in a terminal session. It hosts the API endpoints at `http://localhost:8789/api/*`.

---

## 3. Test Subscription Flow (Local Dev Mock)

Open the notification signup page (compiled by Eleventy at `/notifications/` or served locally) and submit a subscription.

### Trigger via curl:
```bash
curl -X POST http://localhost:8789/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "supporter@tampamonitor.com", "keywords": ["rezoning", "ybor"]}'
```

### Result:
The response body is always the same uniform message (anti-enumeration), but in dev mode it also includes the verification link directly:
```json
{"success":true,"message":"If your email is eligible, a verification link has been sent. Please check your inbox.","devVerifyUrl":"http://localhost:8789/api/verify?token=YOUR_VERIFY_TOKEN"}
```
The same link is also printed in the Wrangler console as a mock email (`[LOCAL DEV - EMAIL MOCK]`), since `RESEND_API_KEY` is not present.

Copy and visit that link in your browser to verify the email and activate the keywords.

---

## 4. Manage Keywords Dashboard

Once verified, you can access the dashboard.
To request a new passwordless login link:
```bash
curl -X POST http://localhost:8789/api/manage \
  -H "Content-Type: application/json" \
  -d '{"email": "supporter@tampamonitor.com"}'
```
The response carries the link as `devManageUrl` in dev mode (it is also printed in the Wrangler terminal as `[LOCAL SEND MANAGEMENT LINK]`):
```text
http://localhost:8789/notifications/?email=supporter%40tampamonitor.com&token=YOUR_MANAGE_TOKEN
```
Navigate to that URL to add or delete keywords up to the supporter limit of 15. The link expires after 15 minutes.

Note the response body is the same uniform message whether or not the email is registered; only the dev-mode `devManageUrl`/`devVerifyUrl` fields reveal state locally.

---

## 5. Evaluate Historical Matches (CLI Report)

We have a dedicated script to verify matches against historical agenda data stored in `data/meetings.db`.

To run the matching report:
```bash
node scripts/test-matching.js
```
This logs matched keywords in the terminal and outputs a full Markdown summary report to:
`docs/TEST-MATCHING-RESULTS.md`

---

## 6. Trigger Webhook & Verify Idempotency

This is the endpoint the manual dispatch workflow (`dispatch-notifications.yml` / `scripts/dispatch-notifications.js`) calls after the WordPress agenda is published.

The endpoint fails closed: requests without a matching `X-Webhook-Secret` header are rejected (401), and the secret must be set in `site/.dev.vars` (the value below matches the Prerequisites example).

### Step A: Send Mock Payload (First Dispatch)
POST a payload containing meeting items that match the keywords subscribed in step 3 (`rezoning`, `ybor`):
```bash
curl -X POST http://localhost:8789/api/notify \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: any-local-secret" \
  -d '{
    "meetings": [
      {
        "meetingId": "2833",
        "meetingDate": "June 4, 2026",
        "meetingType": "regular",
        "title": "City Council Regular Session",
        "agendaItems": [
          {
            "agendaItemId": "24442",
            "number": 1,
            "fileNumber": "E2026-15",
            "title": "Public hearing on Ybor district overlay",
            "background": "Testing some background with the Ybor name in it."
          },
          {
            "agendaItemId": "23714",
            "number": 3,
            "fileNumber": "PS26-23714",
            "title": "Resolution for rezoning of the Station 24 site",
            "background": ""
          }
        ]
      }
    ]
  }'
```

### Result:
You will receive `{"success":true,"sentCount":1,"matchesLogged":2}` — one digest email (mocked in the Wrangler terminal and echoed back as `devEmails` in dev mode) covering both matched items for `supporter@tampamonitor.com`.

### Step B: Test Idempotency (Second Dispatch)
Execute the exact same `curl` command again.
- **Expected Result**: `{"success":true,"sentCount":0,"matchesLogged":0}`. The system correctly identifies that these items have already been notified in the `notification_log` database, avoiding duplicate emails.

---

## 7. Test Two-Step Unsubscribe

Unsubscribe is deliberately two requests: `GET` shows a confirmation page (so mail-scanner link prefetching can't delete subscriptions) and the deletion only happens on `POST`. The unsubscribe link appears in the footer of the mocked digest email from step 6.

```bash
# GET — renders the confirmation page, must NOT delete the subscription
curl -s "http://localhost:8789/api/unsubscribe?token=YOUR_UNSUB_TOKEN" | grep "Yes, unsubscribe me"

# POST — performs the deletion (303 redirect to the status page)
curl -s -i -X POST "http://localhost:8789/api/unsubscribe" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "token=YOUR_UNSUB_TOKEN" | grep -i "^HTTP\|^location"
```

Confirm the subscription and its keywords are gone:
```bash
npx wrangler d1 execute tampa-meetings-notifications --local --command="SELECT COUNT(*) FROM subscriptions; SELECT COUNT(*) FROM keywords;"
```

---

## Production Deployment & Configuration Steps

To roll out the keyword notification system to your live site, complete the following setup steps in your Cloudflare and GitHub environments.

### 1. Apply D1 Migrations to Remote Database
Apply the schema updates to your live production D1 database:
```bash
npx wrangler d1 migrations apply tampa-meetings-notifications --remote
```

### 2. Configure Cloudflare Pages Environment Variables & Secrets
Log into your Cloudflare Dashboard, go to your **Pages Project** settings under **Settings > Environment Variables**, and add the following variables:

| Variable Name | Type | Value / Purpose |
| :--- | :--- | :--- |
| `RESEND_API_KEY` | **Secret** | Your Resend API key (e.g. `re_xxxx`). **Required** — subscribe/manage/notify return errors without it. |
| `WEBHOOK_SECRET` | **Secret** | A secure, randomly generated token (e.g. using `openssl rand -hex 24`). **Required** — `/api/notify` refuses all requests when unset. |
| `TURNSTILE_SECRET_KEY` | **Secret** | Cloudflare Turnstile secret key. **Required** — bot verification fails closed in production. Pair with `TURNSTILE_SITE_KEY` at Eleventy build time. |
| `REGISTRATION_MODE`| **Variable** | Set to `SUPPORTERS_ONLY` (default for private beta), `BETA_AND_SUPPORTERS`, or `PUBLIC`. |

Do **not** set `ENVIRONMENT="development"` in production — it gates the mock-email and dev-link behavior.

*Note: Remember to redeploy or restart the deployment for new environment variables to take effect.*

### 2b. Add a WAF Rate-Limiting Rule
The in-process IP rate limiter in `_middleware.js` is best-effort only (per-isolate, per-colo). In the Cloudflare dashboard, add a rate-limiting rule (available on the free plan) covering `/api/subscribe` and `/api/manage`, e.g. 10 requests per minute per IP.

### 3. Configure GitHub Action Secrets
To allow the nightly scrape workflow to authenticate and call your live notify webhook, you must add the webhook secret to your repository secrets:
1. Go to your GitHub Repository.
2. Navigate to **Settings > Secrets and variables > Actions**.
3. Click **New repository secret**.
4. Name: `WEBHOOK_SECRET`
5. Value: *[Insert the exact same random token you generated for `WEBHOOK_SECRET` in Cloudflare]*

### 4. Deploy Frontend and Functions
Build and deploy the application to Cloudflare Pages:
```bash
# Build the Eleventy static output
npm run build-site

# Deploy to Cloudflare Pages
npm run deploy
```

### 5. Seeding Remote Supporter & Beta Lists
During the private beta, you can manually authorize emails in your production D1 instance by running execute commands with the `--remote` flag:

- **Add an Active Supporter**:
  ```bash
  npx wrangler d1 execute tampa-meetings-notifications --remote --command="INSERT OR REPLACE INTO supporters (email, tier, source, active_until) VALUES ('user@tampamonitor.com', 'supporter', 'manual', NULL);"
  ```
- **Add a Beta Tester**:
  ```bash
  npx wrangler d1 execute tampa-meetings-notifications --remote --command="INSERT OR REPLACE INTO beta_testers (email) VALUES ('tester@example.com');"
  ```

---

## Reference Source Files

- Webhook Handler: [notify.js](file:///Users/miklb/Sites/meetings/site/functions/api/notify.js)
- Manual Dispatcher: [dispatch-notifications.js](file:///Users/miklb/Sites/meetings/scripts/dispatch-notifications.js)
- Match Validation CLI: [test-matching.js](file:///Users/miklb/Sites/meetings/scripts/test-matching.js)

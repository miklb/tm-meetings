# Keyword Notification System — Plan

## Overview

Build a system where users subscribe to keywords (e.g., "rezoning", "Ybor", "$1 million") and receive email notifications when new or updated agenda items match those keywords. Uses Cloudflare D1 for subscription storage, Pages Functions for the API, and Resend for email delivery. Triggered by the existing nightly scrape workflow.

---

## Architecture

```
User subscribes via form on static site
        ↓
Pages Function → D1 (stores subscription)
        ↓ (verification email via Resend)
User confirms email
        ↓
[Nightly scrape detects changes]
        ↓
GitHub Action POSTs changed items → Worker webhook
        ↓
Worker queries D1 for matching keywords
        ↓
Worker sends notifications via Resend API
```

---

## Services

### Cloudflare (all free tier)

| Service         | Purpose                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| D1              | Subscription storage — keywords, emails, supporter tier, notification log |
| Pages Functions | Subscription API (subscribe, verify, unsubscribe, manage)                 |
| Workers         | Webhook endpoint for keyword matching + notification dispatch             |
| R2              | Already in use for document mirroring — no changes needed                 |

### External

| Service | Purpose                      | Cost                            |
| ------- | ---------------------------- | ------------------------------- |
| Resend  | Transactional email delivery | Free (100 emails/day, 1 domain) |

**Why Resend:** Simple REST API, fetch-compatible in Workers, good deliverability with DKIM/SPF, sufficient free tier for civic tool scale. Cloudflare MailChannels was deprecated in 2024.

---

## D1 Schema

### `subscriptions`

```sql
CREATE TABLE subscriptions (
  id               TEXT PRIMARY KEY,          -- nanoid
  email            TEXT NOT NULL UNIQUE,
  verified         INTEGER DEFAULT 0,
  verification_token TEXT,
  unsubscribe_token  TEXT UNIQUE,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
```

### `keywords`

```sql
CREATE TABLE keywords (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id  TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  keyword          TEXT NOT NULL,             -- lowercased, trimmed
  match_type       TEXT DEFAULT 'contains',   -- contains | exact_phrase | file_number
  UNIQUE(subscription_id, keyword)
);
```

### `notification_log`

```sql
CREATE TABLE notification_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id  TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
  meeting_id       TEXT,
  agenda_item_id   TEXT,
  keyword_matched  TEXT,
  sent_at          TEXT DEFAULT (datetime('now'))
);
```

Prevents duplicate notifications if the webhook is called more than once for the same scrape run.

### `supporters`

```sql
CREATE TABLE supporters (
  email             TEXT PRIMARY KEY,          -- lowercased, from Stripe
  stripe_customer_id TEXT,
  tier             TEXT DEFAULT 'free',        -- free | supporter
  source           TEXT,                       -- monthly | annual | donation
  active_until     TEXT,                       -- NULL for active recurring; ISO date for one-time/annual
  updated_at       TEXT DEFAULT (datetime('now'))
);
```

Synced from Stripe via webhooks. The `subscriptions` table checks this table to enforce keyword limits.

---

## Supporter Tiers

| Tier      | Keyword Limit | Who Qualifies                                                   |
| --------- | ------------- | --------------------------------------------------------------- |
| Free      | 3 keywords    | Default for all subscribers                                     |
| Supporter | 15 keywords   | Active monthly/annual Stripe subscriber, or qualifying donation |

### Stripe Webhook Sync

Rather than calling the Stripe API on every subscribe request, a dedicated endpoint keeps the `supporters` table synced in real-time via Stripe webhooks.

**Webhook endpoint:** `POST /api/stripe-webhook`

**Events to handle:**

| Event                           | Action                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `customer.subscription.created` | Upsert supporter, set `tier = supporter`, `source = monthly`                           |
| `customer.subscription.updated` | Update status/tier accordingly                                                         |
| `customer.subscription.deleted` | Start 30-day grace period, then downgrade                                              |
| `checkout.session.completed`    | If one-time payment meets threshold, set `source = donation`, calculate `active_until` |
| `charge.refunded`               | Downgrade to free                                                                      |

**Security:** Verify `Stripe-Signature` header using webhook signing secret (stored as Worker secret `STRIPE_WEBHOOK_SECRET`). Deduplicate using `event.id` to handle retries idempotently.

**Stripe Dashboard config required:**

- Add webhook endpoint: `https://meetings.tampamonitor.com/api/stripe-webhook`
- Subscribe to: `customer.subscription.*`, `checkout.session.completed`, `charge.refunded`
- Copy the signing secret to Worker secrets as `STRIPE_WEBHOOK_SECRET`

### Downgrade Behavior (30-Day Grace Period)

When a supporter's subscription lapses:

1. Stripe fires `customer.subscription.deleted`
2. Worker records the lapse date in `supporters.active_until`
3. For 30 days, subscriber retains their full keyword limit
4. After 30 days, a scheduled check (or the next subscribe/manage request) pauses keywords beyond limit 3 — oldest 3 remain active, extras are marked `paused` (not deleted)
5. Notification email informs them of the lapse and includes a link to resubscribe on tampamonitor.com

> Note: Paused keywords are restored immediately if the supporter reactivates.

### Annual/One-Time Qualification (Decision Pending)

- **Monthly subscribers** ($5 or $10/mo): automatically qualify for supporter tier while active
- **Existing $50+ donors**: should be retroactively granted supporter tier — requires manual Stripe metadata tagging for now
- **Future one-time donations**: threshold and auto-segmentation rules TBD

**Recommended approach:** Tag qualifying Stripe customers with `metadata.tier = supporter` in the Stripe Dashboard. The webhook handler reads this metadata and upserts the `supporters` table accordingly. Keeps business logic in Stripe without code changes.

> This is the one open decision that must be resolved before Phase 2 implementation begins.

---

## Implementation Phases

### Phase 1 — Infrastructure

1. Create `wrangler.toml` at project root — D1 binding, Pages project name, environment variables
2. Create D1 database: `wrangler d1 create tampa-meetings-notifications`
3. Write and apply migration: `migrations/0001_create_tables.sql` (all four tables above)
4. Set up Resend account — verify `tampamonitor.com` domain, store API key as Worker secret (`RESEND_API_KEY`)
5. Add `WEBHOOK_SECRET` as Worker secret (shared with GitHub Actions)

### Phase 2 — Subscription API

6. **Subscription form page** (`site/src/notifications.njk`)
   - Accessible form: email input + keyword input (comma-separated)
   - Progressive enhancement: works without JS; JS adds tag-style UI
   - Shows tier limits inline ("Free accounts: 3 keywords. [Support the project](https://tampamonitor.com/support) for up to 15.")
   - WCAG 2.1 AA compliant

7. **Pages Functions** (`site/functions/api/`):
   - `POST /api/subscribe` — validate email + keywords, check `supporters` table for tier, insert D1, send verification email
   - `GET /api/verify?token=xxx` — mark verified, redirect to success page
   - `GET /api/unsubscribe?token=xxx` — delete subscription and all keywords, redirect to confirmation
   - `POST /api/manage` — update keywords (auth via email + unsubscribe_token); enforces tier limit
   - `POST /api/stripe-webhook` — verify Stripe signature, upsert `supporters` table

8. **Rate-limiting middleware** (`site/functions/api/_middleware.js`)
   - 5 requests/minute per IP to prevent subscription spam
   - CORS headers for same-origin form submissions

9. **Email templates** (plain text + HTML):
   - Verification email with confirm link
   - Notification email: list of matched agenda items with matched keyword highlighted, unsubscribe link at bottom
   - Unsubscribe confirmation
   - Grace period warning (when supporter subscription lapses)

### Phase 3 — Matching & Dispatch

10. **Webhook handler** (`site/functions/api/notify.js`)
    - `POST /api/notify` secured with `WEBHOOK_SECRET` header
    - Receives array of changed agenda items from GitHub Action

11. **Keyword matching logic**
    - Query all verified subscriptions + keywords from D1
    - For each agenda item, search these fields:
      - `title` — main item description
      - `background` — extracted staff report text
      - `fileNumber` — e.g. `REZ26-0042`
      - `supportingDocuments[].title` — document names
    - Match types:
      - `contains` — case-insensitive substring (default)
      - `exact_phrase` — word-boundary aware match
      - `file_number` — prefix match against `fileNumber`
    - One email per subscriber per scrape run (aggregate all matches)

12. **Notification dispatch**
    - Group matched items by subscriber
    - Build email body: meeting date, item title, matched keyword, link to meeting page
    - Send via Resend batch API
    - Log each notification to `notification_log` to prevent duplicates on retry

### Phase 4 — GitHub Action Integration

13. **Update `.github/workflows/nightly-scrape.yml`**
    - After "Commit and push changes", if `has_meaningful == 'true'`
    - Extract changed items from staged JSON diff (titles, backgrounds, file numbers)
    - `POST` as JSON to `https://meetings.tampamonitor.com/api/notify`
    - Include `X-Webhook-Secret: ${{ secrets.WEBHOOK_SECRET }}` header
    - Fire-and-forget: non-blocking, failure doesn't fail the scrape job

---

## File Map

### New files

| File                                   | Purpose                                        |
| -------------------------------------- | ---------------------------------------------- |
| `wrangler.toml`                        | D1 binding, Pages config, environment bindings |
| `migrations/0001_create_tables.sql`    | D1 schema for all four tables                  |
| `site/src/notifications.njk`           | Subscription form page                         |
| `site/functions/api/subscribe.js`      | Subscribe endpoint                             |
| `site/functions/api/verify.js`         | Email verification endpoint                    |
| `site/functions/api/unsubscribe.js`    | Unsubscribe endpoint                           |
| `site/functions/api/manage.js`         | Keyword management endpoint                    |
| `site/functions/api/notify.js`         | Webhook: matching + dispatch                   |
| `site/functions/api/stripe-webhook.js` | Stripe event handler → D1 sync                 |
| `site/functions/api/_middleware.js`    | CORS + rate limiting                           |

### Modified files

| File                                   | Change                                          |
| -------------------------------------- | ----------------------------------------------- |
| `.github/workflows/nightly-scrape.yml` | Add webhook POST step after changes committed   |
| `site/eleventy.config.js`              | Add notifications page to navigation (optional) |

---

## Verification Checklist

- [ ] Keyword matching unit tests against real agenda JSON from `agenda-scraper/data/`
- [ ] End-to-end subscription flow locally via `wrangler pages dev` with D1 local
- [ ] POST sample agenda changes to local webhook — verify emails generated correctly (Resend test mode)
- [ ] Idempotency: POST same payload twice, confirm no duplicate emails (`notification_log` check)
- [ ] Unsubscribe flow: click link, confirm subscription and keywords removed from D1
- [ ] Stripe webhook: simulate `subscription.deleted` event, confirm 30-day grace logic
- [ ] Over-limit error: free subscriber trying to add 4th keyword gets rejection with support link
- [ ] Trigger full pipeline via `workflow_dispatch` on GitHub, verify notifications arrive
- [ ] Accessibility audit on subscription form (keyboard nav, screen reader, contrast ≥ 4.5:1)

---

## Key Decisions

| Decision               | Choice                             | Rationale                                                   |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------- |
| API location           | Pages Functions                    | Co-located with site, single deploy, single `wrangler.toml` |
| Email service          | Resend                             | Simplest Worker-compatible API, sufficient free tier        |
| Trigger mechanism      | Webhook from GitHub Action         | GH Action already knows what changed; no polling needed     |
| Notification format    | Email only                         | No SMS/push in v1                                           |
| Opt-in                 | Double opt-in (verification email) | Anti-spam compliance (CAN-SPAM, GDPR)                       |
| Meeting type filter    | None                               | Keyword-only for v1                                         |
| Supporter grace period | 30 days                            | Avoid frustration on billing edge cases                     |
| Keyword limits         | Free: 3, Supporter: 15             | Mitigates Resend costs + abuse; incentivizes support        |
| Stripe sync            | Webhook → D1, not live API calls   | Fast, no external dependency on subscribe path              |

---

## Open Decision

**Annual/one-time supporter qualification** — must be resolved before Phase 2 begins.

- Monthly subscribers ($5/$10/mo): automatically qualify ✓
- Existing $50+ donors: grant retroactively via Stripe metadata tagging
- Future one-time donors: decide threshold (e.g., ≥$50 = 1 year) and whether to auto-tag in Stripe or handle in the CF Worker checkout (part of `tm-donate` migration)

Recommended: set `metadata.tier = supporter` on qualifying Stripe customers; webhook reads this field. No code change needed when rules change.

---

_Created: 2026-04-19_

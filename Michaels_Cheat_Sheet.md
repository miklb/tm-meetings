# Michael's Cheat Sheet

Two top-level npm scripts drive everything. Both accept a date like `2026-04-16`.

| Command                         | When                   | What it does                                                                      |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `npm run agenda -- YYYY-MM-DD`  | Friday (pre-meeting)   | Scrape agenda from Hyland → mirror PDFs to R2 → generate `*.wp.html`              |
| `npm run archive -- YYYY-MM-DD` | Tuesday (post-meeting) | Scrape transcript → capitalize → match YouTube video + offset → rebuild DB + site |

Note the `--` separator: without it npm swallows the args.

## Friday — Agenda prep

```bash
git pull
npm run agenda -- YYYY-MM-DD                  # convert + mirror using existing JSON (no re-scrape)
npm run agenda -- YYYY-MM-DD --force          # re-scrape, then convert + mirror
npm run agenda -- YYYY-MM-DD --skip-mirror    # skip R2 mirroring
```

If a JSON for the date already exists (e.g. from the nightly GH Action), the scrape step is skipped. Use `--force` to re-scrape anyway.

Output: `agenda-scraper/agendas/agenda_YYYY-MM-DD.wp.html` plus mirrored PDFs on R2.

## Tuesday — Archive the meeting

```bash
npm run archive -- YYYY-MM-DD
npm run deploy
```

Options:

```bash
npm run archive -- YYYY-MM-DD --skip-video          # no YouTube match / offset
npm run archive -- YYYY-MM-DD --skip-site           # no DB + site rebuild
npm run archive -- YYYY-MM-DD --meeting-type CRA    # override auto-detection
npm run archive -- YYYY-MM-DD --dry-run             # show what would run
```

## Rebuild only

If you fixed data by hand and just need to republish:

```bash
npm run build-db        # rebuild SQLite (scripts/build-db.js)
npm run build-site      # Eleventy build
npm run deploy          # wrangler pages deploy site/_site --project-name tampa-meetings
```

## Add beta testers

When someone answers the call for testers, add them to remote D1 (takes effect
immediately — no deploy). They then subscribe themselves at
<https://meetings.tampamonitor.com/notifications/>.

```bash
./scripts/add-beta-tester.sh someone@example.com another@example.com
./scripts/add-beta-tester.sh --list      # show the current list
```

Emails are lowercased/trimmed and validated; re-adding an existing tester is a
no-op. The script prints the full list after inserting.

**Seeding is not subscribing.** `add-beta-tester.sh` only makes someone *eligible*.
They get no email until they sign up at `/notifications/`, click the verification
link, and add keywords. Check who is actually live with the preview below.

## Fire a notification test

Dispatch is manual and has **no dry-run** — it POSTs to production and emails every
matching verified subscriber. Always preview first.

```bash
# 1. Which meeting? (the ID is in the JSON filename)
ls agenda-scraper/data/meeting_*_2026-07-16.json   # -> meeting_2815_...

# 2. Preview — read-only, sends nothing. Prints who gets what,
#    what's suppressed as already-sent, and any zero-match keywords.
node scripts/preview-dispatch.js --meeting-ids=2815

# 3. Send. dispatch-notifications.js does NOT read .env, so pass the secret in.
WEBHOOK_SECRET="$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2-)" \
MEETING_IDS=2815 \
WORDPRESS_AGENDA_URL="https://tampamonitor.com/tampa-city-council/<the-agenda-post>" \
  node scripts/dispatch-notifications.js
```

The preview's `Summary: would send N email(s)` should equal the `"sentCount":N` the
dispatch reports back. If it doesn't, stop and find out why before re-running.

Always pass `WORDPRESS_AGENDA_URL`. Without it the digest's "View full agenda" link
silently falls back to the static site. Item deep-links use `#item-<agendaItemId>`
(the OnBase id, **not** the File No.).

### New tester joins mid-week — same agenda

Just re-run the same dispatch. Dedup is per `(subscriber, item, keyword)`, so the
new tester gets the digest and everyone already notified is skipped automatically.
Preview first to confirm only the newcomer is listed.

### Re-test with someone who was already emailed

Dedup will suppress them, so you must clear their rows first (remote D1):

```bash
cd site
npx wrangler d1 execute tampa-meetings-notifications --remote \
  --command="DELETE FROM notification_log WHERE meeting_id = '2815' AND subscription_id = (
    SELECT id FROM subscriptions WHERE email = 'you@example.com');"
```

Drop the `subscription_id` clause to reset the whole meeting for everyone.

### Next week's meeting

Same three steps, with the new meeting ID — but the agenda has to exist and be
published first:

```bash
npm run agenda -- YYYY-MM-DD        # scrape/convert/mirror -> agendas/agenda_<date>.wp.html
# publish that wp.html as the WordPress post, copy its URL
node scripts/preview-dispatch.js --meeting-ids=<new-id>
# ...then the send command above with the new ID + URL
```

Run the dispatch **after** the WP post is up and the Monday newsletter has gone out.

### Keywords: expect noise, and expect silent misses

`contains` keywords are boundary-less substring matches. Two failure modes to keep in
mind when reading a preview:

- **Noise** — `howard` matches "**Howard** F. Curren Advanced Wastewater Treatment
  Plant" (a plant named after a person, not the street).
- **Silent misses** — the *more specific* a keyword, the more brittle. `south howard
  flood project` matched **nothing** on the 7/16 agenda, because the City's actual
  wording is "South Howard Flood **Relief and Streetscape** Project". A zero-match
  keyword is worse than a noisy one: nothing tells the subscriber they missed items.

The preview lists zero-match keywords per subscriber so you can spot dead ones. Their
keywords are theirs — surface it in messaging, don't rewrite them.

## subscribe.js

The one rule that matters: emails must be stored lowercased and trimmed.

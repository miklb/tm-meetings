# Michael's Cheat Sheet

Two top-level npm scripts drive everything. Both accept a date like `2026-04-16`.
Background/history lives in [Michaels_Notes.md](Michaels_Notes.md).

| Command                         | When                   | What it does                                                                        |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `npm run agenda -- YYYY-MM-DD`  | Friday (pre-meeting)   | Scrape agenda from Hyland → mirror PDFs to R2 → reconcile OpenGov → tm-static post  |
| `npm run archive -- YYYY-MM-DD` | Tuesday (post-meeting) | Scrape transcript → capitalize → match YouTube video + offset → rebuild DB + site   |

Note the `--` separator: without it npm swallows the args.

## Friday — Agenda prep

```bash
git pull
npm run agenda -- YYYY-MM-DD                  # re-scrape, then convert + mirror
npm run agenda -- YYYY-MM-DD --skip-mirror    # skip R2 mirroring
```

Always re-scrapes (no `--force` needed since 2026-08-20): date runs only touch meetings on that date — other meetings' JSONs and their `mirroredUrl` stamps are left alone — and the mirror step re-stamps right after.

Output: mirrored PDFs on R2, `agenda-scraper/agendas/agenda_YYYY-MM-DD.md` (record copy), and the tm-static post written/updated in `~/Sites/tm-static/src/posts/<year>/` — commit + push tm-static to publish.

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

After any deploy that rebuilt the site, smoke-check the notifications signup form
still has its Turnstile widget (build-time injected; without it every signup gets
"Bot verification failed" — this bit us in Aug 2026):

```bash
curl -s https://meetings.tampamonitor.com/notifications/ | grep -c data-sitekey   # expect 2
```

The Turnstile *site* key is committed in `site/src/_data/turnstile.js` (public by
design); only `TURNSTILE_SECRET_KEY` is a Pages secret.

## Send notifications (dispatch)

Dispatch is manual and has **no dry-run** — it POSTs to production and emails every
matching verified subscriber. Always preview first. Run **after** the agenda post
is live on tampamonitor.com and the Monday newsletter has gone out.

```bash
# 1. Which meeting? (the ID is in the JSON filename)
ls agenda-scraper/data/meeting_*_2026-07-16.json   # -> meeting_2815_...

# 2. Preview — read-only, sends nothing. Prints who gets what,
#    what's suppressed as already-sent, and any zero-match keywords.
node scripts/preview-dispatch.js --meeting-ids=2815

# 3. Send. dispatch-notifications.js does NOT read .env, so pass the secret in.
#    (WORDPRESS_AGENDA_URL is a legacy name — it's the tm-static agenda post URL.)
WEBHOOK_SECRET="$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2-)" \
MEETING_IDS=2892,2923 \
WORDPRESS_AGENDA_URL="https://tampamonitor.com/tampa-city-council/agendas/<slug>/" \
  node scripts/dispatch-notifications.js
```

The preview's `Summary: would send N email(s)` should equal the `"sentCount":N` the
dispatch reports back. If it doesn't, stop and find out why before re-running.

Always pass `WORDPRESS_AGENDA_URL`. Without it the digest's "View full agenda" link
silently falls back to the static site. Item deep-links use `#item-<agendaItemId>`
(the OnBase id, **not** the File No.).

**New subscriber mid-week, same agenda:** just re-run the same dispatch. Dedup is
per `(subscriber, item, keyword)`, so they get the digest and everyone already
notified is skipped. Preview first to confirm only the newcomer is listed.
(Clearing dedup rows to force a re-send: see the notes file.)

### Keywords: expect noise, and expect silent misses

`contains` keywords are boundary-less substring matches. Two failure modes to keep in
mind when reading a preview:

- **Noise** — `howard` matches "**Howard** F. Curren Advanced Wastewater Treatment
  Plant" (a plant named after a person, not the street).
- **Silent misses** — the _more specific_ a keyword, the more brittle. `south howard
flood project` matched **nothing** on the 7/16 agenda, because the City's actual
  wording is "South Howard Flood **Relief and Streetscape** Project". A zero-match
  keyword is worse than a noisy one: nothing tells the subscriber they missed items.

The preview lists zero-match keywords per subscriber so you can spot dead ones. Their
keywords are theirs — surface it in messaging, don't rewrite them.

## subscribe.js

The one rule that matters: emails must be stored lowercased and trimmed.

## yt-dlp maintenance (video downloads for offset sync)

YouTube requires PO tokens now; the setup (2026-08-17) is: yt-dlp **nightly**
+ the bgutil plugin in the processor venv + a token-generator script at
`~/bgutil-ytdlp-pot-provider` + `~/.config/yt-dlp/config` (node JS runtime).
Monthly-ish, or whenever downloads start 403ing again:

```
transcript-cleaner/processor/venv/bin/pip install -U --pre yt-dlp
transcript-cleaner/processor/venv/bin/pip install -U bgutil-ytdlp-pot-provider
cd ~/bgutil-ytdlp-pot-provider && git pull && cd server && npm ci && npx tsc
```

(`--pre` matters: the stable channel lags the YouTube arms race.) Health
check: `venv/bin/yt-dlp -v --simulate <any council video> 2>&1 | grep "PO Token
Providers"` should list `bgutil:script-node-… (external)`. The download step
also retries 3× on its own before giving up.

## Rerun transcript sync

```
venv/bin/python scripts/build/resync_offsets.py --dry-run          # see what's pending
venv/bin/python scripts/build/resync_offsets.py --limit 10         # ~1 hour chunk
venv/bin/python scripts/build/resync_offsets.py --since 2025-10-01 # FY26 only
```

One open item from the 2025 backfill: how the 11/20/25 dropped-stream meeting's
two parts should split the transcript — details in
[Michaels_Notes.md](Michaels_Notes.md).

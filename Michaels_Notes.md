# Michael's Notes

Background and history moved out of the cheat sheet. Nothing here is part of
the weekly routine; it's context for when something old resurfaces.

## Notifications: beta-tester era (dormant since public launch 2026-07-20)

Signup is PUBLIC now (`site/functions/api/subscribe.js` checks `regMode`), but
the `beta_testers` table and gate still exist if signup ever needs restricting
again:

```bash
./scripts/add-beta-tester.sh someone@example.com   # add to remote D1, immediate
./scripts/add-beta-tester.sh --list                # show the current list
```

Seeding is not subscribing — the list only makes an email *eligible*; people
still sign up, verify, and add keywords themselves at `/notifications/`.

**Re-sending to someone already emailed for a meeting** (dedup is per
`(subscriber, item, keyword)` in `notification_log`, remote D1):

```bash
cd site
npx wrangler d1 execute tampa-meetings-notifications --remote \
  --command="DELETE FROM notification_log WHERE meeting_id = '2815' AND subscription_id = (
    SELECT id FROM subscriptions WHERE email = 'you@example.com');"
```

Drop the `subscription_id` clause to reset the whole meeting for everyone.

## 2025 backfill — ledger (spot-check list retired from the cheat sheet)

Open item:

- **11/20/25 (pkey 2646), Part 2** `qzEIjT5agGU` — offset −199s with no
  `transcript_start_time`. Known dropped-stream meeting: the restart re-covers
  late-morning content, which is why the anchors landed there. **Still to
  decide: how the two parts should split the transcript.**

Background that may matter again:

- **CRA remaps** — 8/21 (2625), 9/11 (2631), 12/11 (2648): videos manually
  reassigned to "Community Redevelopment Agency – MM/DD/25" titles that the
  "City Council" YouTube search can't find. If a CRA video ever looks wrong,
  check the title mapping first.
- **11/10/25 Special Call** — permanent gap: tampagov never published a
  transcript. Agenda-only; nothing to fix.
- **9/18/25 regular (2666)** — agenda JSON is an old-format scrape (no
  `sourceUrl`). Fine in the DB; only matters if the page looks off.

Resolved (for the record):

- **12/11/25 CRA (2648)** — offset 1848s (30:48 pre-roll) via targeted window.
- **7/24/25 CRA (2615)** — two-part video, P1=382s, P2=707s,
  `transcript_start_time` 1:38:39 PM from fresh gap detection.
- **9/4/25 (2630), Part 2** `-dVf1L2oHZY` — the repeated "download failures"
  were never yt-dlp: the video ID starts with a dash and argparse ate it as a
  flag. Fixed 2026-08-17 (`--` before the ID at every
  `transcribe_with_whisper.py` call site); offset landed same day: P2=1037s,
  6 anchors within 3.4s.
- **8/11/25 AM workshop (2624)** — offset −65s is legitimate: the video starts
  ~1 min after the call to order, so the earliest transcript links clamp to
  t=0.
- **7/17/25 budget presentation (2620)** — two parts, 72-min lunch gap, Part 2
  at 1:38 PM; links verified on both sides of the gap.

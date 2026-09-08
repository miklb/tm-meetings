# Bug Punch-List

## Open

- [ ] **Agenda Scraper GH Action fails** - the current nightly GH action that runs in the evening fails.
  - Diagnosis (2026-09-03 review): `json-scraper.js` sets `exitCode=1` when any single meeting errors; the scrape step propagates it and the commit/push/issue steps have no `if: always()`, so one flaky OnBase fetch fails the whole run and drops all successful data for the night. Fix is `continue-on-error` on the scrape step. Planned in `fix/nightly-ci`.

## Fixed

<!-- Move items here when resolved, with date and fix summary -->

- [x] **Timestamp sync off by ~15 seconds** — fixed 2026-09-08 (`fix/offsets-and-midnight`). The 9/3 review blamed
  the n-gram fallback's early-segment override; audio checks (`scripts/verify-offset.py`) on every cached run where
  that override decides showed it *beats* the cluster median in 6 of 7, so it stays. The drift case (6/4/26 meeting,
  stored 550 s, true 565 s) came from the word-anchor pass finding two anchors that agreed within 0.4 s and then
  discarding them as "fewer than 3". Fix: two anchors within 2 s now count. Replaying all 83 cached Whisper runs:
  80 offsets unchanged, 3 move (2683: 550→565, 2647: 492→490, 2698: 498→496), each confirmed against the audio.
  Stored offsets are not rewritten by the fix — re-run the matcher on a meeting's cache, or `resync_offsets.py`, to
  apply. The matcher now exits 2 when it cannot find an offset, so `resync_offsets.py` no longer records a failure
  as a "Δ+0s" success. Same branch: transcript timestamps after midnight (evening sessions ending at 12:32 AM /
  3:04 AM) seek forward in the video instead of clamping to 0:00 (`site/lib/seek-math.js`).
  Still open in spirit: several stored offsets measured 5–34 s off (2618, 2621, 2435) — those runs had no usable
  anchors and the n-gram fallback is simply noisy; a re-download with the current word-timestamp pipeline
  (`resync_offsets.py`) is the remedy, not more matcher logic.

- [x] **Meeting Types Detection** — Case-insensitive `VIDEO_MEETING_TYPE_MAP` lookup in build-db.js; `(?:part|pt)` regex for video part numbers in youtube_fetcher.py (2026-03-20)
- [x] **Fix better-sqlite3 version** — Both site/ and scripts/ package.json already aligned at ^12.6.2 (2026-03-20)
- [x] **Consider lockfiles** — All three lockfiles (site/, scripts/, agenda-scraper/) tracked in git (2026-03-20)

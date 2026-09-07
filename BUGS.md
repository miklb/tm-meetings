# Bug Punch-List

## Open

- [ ] **Timestamp sync off by ~15 seconds** — Last meeting run shows video timestamps drifting; clickable timestamps arrive ~15s early/late relative to actual speech. Needs offset calibration investigation in Whisper match or `offset_seconds` calculation.
  - Diagnosis (2026-09-03 review): the n-gram fallback's early-segment override in `match_whisper_to_transcript.py` (~lines 871-910) replaces the cluster median with a single early fuzzy match. Anchor replay over 40 cached runs shows ≤3s error without it. Planned fix in `fix/offsets-and-midnight`.
- [ ] **Agenda Scraper GH Action fails** - the current nightly GH action that runs in the evening fails.
  - Diagnosis (2026-09-03 review): `json-scraper.js` sets `exitCode=1` when any single meeting errors; the scrape step propagates it and the commit/push/issue steps have no `if: always()`, so one flaky OnBase fetch fails the whole run and drops all successful data for the night. Fix is `continue-on-error` on the scrape step. Planned in `fix/nightly-ci`.

## Fixed

<!-- Move items here when resolved, with date and fix summary -->

- [x] **Meeting Types Detection** — Case-insensitive `VIDEO_MEETING_TYPE_MAP` lookup in build-db.js; `(?:part|pt)` regex for video part numbers in youtube_fetcher.py (2026-03-20)
- [x] **Fix better-sqlite3 version** — Both site/ and scripts/ package.json already aligned at ^12.6.2 (2026-03-20)
- [x] **Consider lockfiles** — All three lockfiles (site/, scripts/, agenda-scraper/) tracked in git (2026-03-20)

# Bug Punch-List

## Open

- [ ] **Timestamp sync off by ~15 seconds** — Last meeting run shows video timestamps drifting; clickable timestamps arrive ~15s early/late relative to actual speech. Needs offset calibration investigation in Whisper match or `offset_seconds` calculation.
- [ ] **Agenda Scraper GH Action fails** - the current nightly GH action that runs in the evening fails.

## Fixed

<!-- Move items here when resolved, with date and fix summary -->

- [x] **Meeting Types Detection** — Case-insensitive `VIDEO_MEETING_TYPE_MAP` lookup in build-db.js; `(?:part|pt)` regex for video part numbers in youtube_fetcher.py (2026-03-20)
- [x] **Fix better-sqlite3 version** — Both site/ and scripts/ package.json already aligned at ^12.6.2 (2026-03-20)
- [x] **Consider lockfiles** — All three lockfiles (site/, scripts/, agenda-scraper/) tracked in git (2026-03-20)

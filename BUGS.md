# Bug Punch-List

## Open

- [ ] **Timestamp sync off by ~15 seconds** — Last meeting run shows video timestamps drifting; clickable timestamps arrive ~15s early/late relative to actual speech. Needs offset calibration investigation in Whisper match or `offset_seconds` calculation.
  - Diagnosis (2026-09-03 review): the n-gram fallback's early-segment override in `match_whisper_to_transcript.py` (~lines 871-910) replaces the cluster median with a single early fuzzy match. Anchor replay over 40 cached runs shows ≤3s error without it. Planned fix in `fix/offsets-and-midnight`.
## Fixed

<!-- Move items here when resolved, with date and fix summary -->

- [x] **Agenda Scraper GH Action fails** — Filed 2026-03-20, the day the workflow was created; the March 20–26 failures were setup teething and the last one (2026-05-04, 15 s into the scrape step) was fixed by "handle server-unavailable meetings gracefully" the same day. 60 consecutive successes since. The design flaw the 9/3 review found — one failed meeting exits non-zero and skips commit/push/issue, dropping the night's successful data — is fixed in `fix/nightly-ci`: `continue-on-error` on the scrape, failures reported in the issue, `scripts/nightly-report.sh` replaces the inline analysis, concurrency group + timeout, rebase before push (2026-09-08)

- [x] **Meeting Types Detection** — Case-insensitive `VIDEO_MEETING_TYPE_MAP` lookup in build-db.js; `(?:part|pt)` regex for video part numbers in youtube_fetcher.py (2026-03-20)
- [x] **Fix better-sqlite3 version** — Both site/ and scripts/ package.json already aligned at ^12.6.2 (2026-03-20)
- [x] **Consider lockfiles** — All three lockfiles (site/, scripts/, agenda-scraper/) tracked in git (2026-03-20)

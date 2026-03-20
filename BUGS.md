# Bug Punch-List

## Open

- [ ] **Timestamp sync off by ~15 seconds** — Last meeting run shows video timestamps drifting; clickable timestamps arrive ~15s early/late relative to actual speech. Needs offset calibration investigation in Whisper match or `offset_seconds` calculation.
- [ ] **Agenda Scraper GH Action fails** - the current nightly GH action that runs in the evening fails.
- [ ] **Fix better-sqlite3 version** — Align package.json to ^12.x to match package.json
- [ ] **Consider lockfiles** — Un-ignore package-lock.json for reproducible CI installs, or add a root package.json with npm workspaces
- [ ] **Meeting Types Detection** — need better checking for CRA meetings especially for video

## Fixed

<!-- Move items here when resolved, with date and fix summary -->

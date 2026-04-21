# Changelog

All notable changes to Tampa Meetings are recorded here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/), and the project follows loose [Semantic Versioning](https://semver.org/) — patch for fixes, minor for new capabilities, major for schema or pipeline breaks.

## [1.0.0] - 2026-04-21

First tagged release. The pipeline is unified and actively processing meetings end-to-end.

### Highlights

- **Agenda scraper** (v3, HTTP-first) extracts file numbers, titles, backgrounds, supporting docs, addresses, coordinates, and financial details from Hyland OnBase
- **Transcript processor** converts ALL CAPS transcripts to sentence case using GLiNER NER and an entity database
- **Video pipeline** (5 steps) matches YouTube recordings to meetings, calculates Whisper-based time offsets for clickable timestamps, and handles multi-part meetings
- **Unified orchestration** via root-level npm scripts:
  - `npm run agenda  -- YYYY-MM-DD` — Friday pre-meeting workflow (scrape + R2 mirror)
  - `npm run archive -- YYYY-MM-DD` — Tuesday post-meeting workflow (transcript + video + DB + site)
- **Document mirroring** to Cloudflare R2 with provenance tracking (`data-original-url`)
- **SQLite + FTS5** database built from JSON by `scripts/build-db.js`; powers an Eleventy static site
- **WordPress publication** via generated block markup (`agenda-scraper/agendas/*.wp.html`)
- **Nightly GitHub Action** scrapes upcoming agendas and opens an issue on changes
- **Accessibility-first** static site (WCAG 2.1 AA): semantic HTML, keyboard nav, ARIA landmarks, transcripts as video alternative

### Known gaps

- Pagefind search — not started
- Datasette API — future
- GitHub Actions for the full pipeline (currently only the nightly scrape runs in CI) — planned

### Versioning notes

- The root `package.json`, `site/package.json`, and `transcript-cleaner/processor/src/__init__.py` all track the repo version (1.0.0 at this release).
- `agenda-scraper/` retains its own version history (currently 3.1.0) because it predates this monorepo and is mirrored to a standalone public repo.
- Going forward: tag `vX.Y.Z` on `main` when a release is worth marking; add a section to this file; let sub-packages drift.

[1.0.0]: https://github.com/miklb/tm-meetings/releases/tag/v1.0.0

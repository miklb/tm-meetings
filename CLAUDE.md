# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Required reading — agent instruction files

Detailed project context for AI assistants lives in `.github/`, which Claude Code does **not** load automatically. Read the relevant file before nontrivial work; they are the authoritative source and this file only summarizes the highest-cost rules.

- [.github/copilot-instructions.md](.github/copilot-instructions.md) — primary context: architecture and tech decisions, code style (JS / Python / Nunjucks / CSS), domain knowledge (meeting types, file-number format `CC25-0015`, document types), the agenda pipeline rules, video pipeline design constraints, external services (R2, D1, YouTube API).
- [.github/instructions/cli-scripts.instructions.md](.github/instructions/cli-scripts.instructions.md) — script-first CLI rule; applies to **all** terminal work.
- [.github/instructions/python-environment.instructions.md](.github/instructions/python-environment.instructions.md) — venv activation, package installs, key paths; applies to all Python.
- [.github/instructions/opengov.instructions.md](.github/instructions/opengov.instructions.md) — OpenGov financial reconciliation: architecture, CLI surface, funding-manifest schema, what's deliberately not built yet. Read before touching `opengov/` or `agenda-scraper/json-to-markdown.js`.
- [.github/workflows/nightly-scrape.yml](.github/workflows/nightly-scrape.yml) — nightly CI scrape: runs the scraper, diffs, notifies, commits data.

## Critical rules

Mistakes here corrupt data, break published pages, or get IPs banned:

1. **Agenda processing** — always `cd agenda-scraper && ./process-agenda.sh <date>`. It chains scraper → R2 mirror → OpenGov reconcile → Markdown generation in a fixed order; a standalone `json-scraper.js` run skips the mirror and manifest steps, so new documents stay on OnBase URLs and financial sections vanish. (Since 2026-09-08 `lib/scrape-guard.js` makes the scrape itself safe: stamps carry forward, failed items keep their stored version, an empty scrape is refused.) Safe partial re-runs (regenerate the markdown post only, re-mirror only, re-reconcile only) are listed in copilot-instructions.md. WordPress generation was retired 2026-07-17.
2. **Two separate Python venvs — never mix them:**
   - Pipeline / transcript / video work: `source pipeline/activate.sh` (venv at `transcript-cleaner/processor/venv/`)
   - OpenGov work: `source .venv/bin/activate` (repo-root `.venv`), then `python3 -m opengov.<module>` from the repo root
3. **No inline CLI code** — never `node -e`, `python3 -c`, or heredocs piped to a runtime. Write a script file (project `scripts/` or a temp file) and run that. One-liner `grep`/`jq`/`awk`/`sed` is fine.
4. **Never use `youtube-transcript-api`** — it causes IP bans. Offset detection uses Whisper (`transcript-cleaner/processor/scripts/build/match_whisper_to_transcript.py`).
5. **Plans and scratch design docs go in `docs/plans/`** (gitignored) — never commit them.
6. **Accessibility (WCAG 2.2 AA) is the primary constraint** for anything under `site/` — semantic HTML, keyboard nav, works without JS.

## Commands

```bash
# Full agenda pipeline for one meeting (scrape → R2 mirror → OpenGov reconcile → tm-static Markdown)
cd agenda-scraper && ./process-agenda.sh <YYYY-MM-DD>

# End-to-end archive of one meeting (auto-activates the venv)
./pipeline/archive-meeting.sh

# Rebuild SQLite DB from scraped data — required after a fresh clone (data/meetings.db is gitignored)
npm run build-db            # node scripts/build-db.js

# Eleventy site
cd site && npm run serve    # dev server
cd site && npm run build    # build to site/_site

# Production deploy (Cloudflare Pages)
npm run deploy              # cd site && wrangler pages deploy --project-name tampa-meetings
```

`npm test` runs the build-db suite (`scripts/test/*.test.js`, Node's built-in runner, synthetic fixtures — no real data). Site changes are verified by building the site and the manual checklist in copilot-instructions.md.

## Architecture

Civic transparency pipeline for Tampa City Council records. Data flows one way:

```
Hyland OnBase ─▶ agenda-scraper/ (Node)      JSON + Markdown; docs mirrored to Cloudflare R2
tampagov.net  ─▶ transcript-cleaner/processor/ (Python)  ALL-CAPS transcripts → sentence case
                                              with NER + YouTube video/timestamp sync
OpenGov CoA   ─▶ opengov/ (separate Python tool)  enriches Summary Sheet dollar amounts →
                                              per-meeting funding manifest
pipeline/     ─▶ orchestration               discover.py, archive-meeting.sh, build-site.sh,
                                              rebuild-entities.sh
scripts/build-db.js ─▶ data/meetings.db (SQLite) ─▶ site/ (Eleventy 3, better-sqlite3)
                                              ─▶ Cloudflare Pages
```

Key coupling to know about: `process-agenda.sh` chains scraper → mirror → reconcile → Markdown generation in a fixed order (see Critical rules #1); the Eleventy build reads `data/meetings.db` directly, so DB rebuild must precede site build after data changes (`pipeline/build-site.sh` does both).

This repo also serves as the reference pattern for the Tampa Monitor static rebuild (`~/tampa-monitor/tm-static`); the `site/` front end is adopting that shared design system (tokens, BEM, no `wp-*` classes).

## Working conventions

- **Transcript capitalization quality bar:** recurring names and locations must be right; perfection is not expected. Over-capitalization is worse than missing an obscure name. Entity/training-data details in [transcript-cleaner/processor/docs/CAPITALIZATION_SOURCES.md](transcript-cleaner/processor/docs/CAPITALIZATION_SOURCES.md).
- **Email:** Resend is the email provider (transactional alerts now, newsletter later). Sends are timed manually — do not build RSS-triggered automation.
- The pipeline is run about once a week; it is deliberately not critical infrastructure. Prefer simple, debuggable fixes over robustness engineering.

## More documentation

- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — roadmap, DB schema, decisions log
- [pipeline/README.md](pipeline/README.md) — pipeline scripts, data flow, typical weekly workflow
- [agenda-scraper/README.md](agenda-scraper/README.md) — scraper usage and output format
- [transcript-cleaner/processor/README.md](transcript-cleaner/processor/README.md) and [WORKFLOW.md](transcript-cleaner/processor/WORKFLOW.md) — transcript processing and video offset guide
- [transcript-cleaner/processor/docs/VIDEO_PIPELINE.md](transcript-cleaner/processor/docs/VIDEO_PIPELINE.md) — video pipeline design (complete)
- [Michaels_Cheat_Sheet.md](Michaels_Cheat_Sheet.md) — the human runbook

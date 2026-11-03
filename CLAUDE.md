# meetings — repo guide

Tampa City Council archive: agenda scraper, document mirror, transcripts, video sync, meetings.tampamonitor.com (11ty on Cloudflare Pages) and keyword notifications. **This repo is public.** Nothing personal, no credentials and no names of private repos (say "a separate private research toolkit") in code, docs, commits or issues. To-dos are GitHub issues here, written for a public reader.

## Read first
`.github/copilot-instructions.md` (architecture, style, domain, pipeline rules; written for Copilot, applies to every agent) and `.github/instructions/*.md` (CLI, Python env, OpenGov). `IMPLEMENTATION_PLAN.md` is what's built plus the schema, not a roadmap. `Michaels_Cheat_Sheet.md` is the human runbook. `MAINTENANCE.md` holds inventory and recipes only.

## Critical rules
1. Agenda processing is `cd agenda-scraper && ./process-agenda.sh <date>`; never `json-scraper.js` alone (it skips the mirror and reconcile). Partial re-runs are listed in copilot-instructions.
2. Two venvs, never mixed: `source pipeline/activate.sh` for pipeline, transcript and video work; `source .venv/bin/activate` then `python3 -m opengov.<module>` for OpenGov.
3. No inline runtime code; write a script file. A one-liner grep, jq or awk is fine.
4. Never `youtube-transcript-api` (IP bans). Offsets come from Whisper (`transcript-cleaner/processor/scripts/build/match_whisper_to_transcript.py`); a change there is replayed and verified against audio with `scripts/verify-offset.py` before it stays.
5. Plans and scratch docs go in gitignored `docs/plans/`. Minutes-parsing files stay uncommitted (gitignored and in `.git/info/exclude`); never `git add` them.
6. WCAG 2.2 AA for `site/`: semantic HTML, keyboard, works without JS. Board pages and alerts show address and request, never owner, applicant or folio.
7. Pipeline and data fixes get fixture tests (`npm test`, `scripts/test/`), not hard-coded override lists.
8. Deploy from the repo root in one line: `npm run build-db && npm run build-site && npm run deploy`. Never `cd site` to deploy.

## Shape
OnBase → `agenda-scraper/` (Node; JSON plus a Markdown post for tm-static; documents mirrored to R2) · tampagov.net → `transcript-cleaner/processor/` (Python; capitalization and YouTube sync) · `opengov/` enriches dollar amounts · `scripts/build-db.js` → `data/meetings.db` → `site/` (Eleventy, better-sqlite3) → Pages · `site/functions/api/` keyword notifications (D1 `supporters`, Resend). The scrape runs nightly in CI; the full archive pipeline is weekly by hand and deliberately not critical infrastructure. Agenda output is editorial: reshape the clerk's structure for readability. Capitalization bar: recurring names right, no over-capitalization.

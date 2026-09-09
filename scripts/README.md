# scripts/

Operator tools run by hand from the repo root, unless noted otherwise below.
Node scripts assume `npm install` has been run in this directory; Python
scripts use the pipeline venv (`source pipeline/activate.sh`) unless marked.

| Script | What it does |
|---|---|
| `add-beta-tester.sh` | Adds email(s) to the `beta_testers` table in remote D1, or lists the current beta-tester list, for the notifications registration-gate flow. |
| `audit-video-offsets.py` | Read-only plausibility check of `video_mapping_<TID>.json` offset values against transcript spans and `data/meetings.db`; flags large/zero/missing offsets. **Pipeline-called** — `archive-meeting.sh` runs it with `--strict`. |
| `build-db.js` | Builds `data/meetings.db` (SQLite) from the agenda JSON in `agenda-scraper/data/`. **Pipeline-called** — `npm run build-db`, and directly from `archive-meeting.sh` / `build-site.sh`. |
| `dispatch-notifications.js` | POSTs to the production `/api/notify` endpoint to send keyword-match notification emails for given meeting id(s). No dry-run — see `preview-dispatch.js` first. |
| `find-speaker-mentions.js` | Scans processed transcript JSON for segments by a given speaker matching a regex; emits a Markdown report with links to the archive page and YouTube timestamp. |
| `preview-dispatch.js` | Dry-run for `dispatch-notifications.js` — mirrors the matching engine against remote D1 read-only to show who would get what before sending. |
| `run-offset-verification.py` | Driver for `verify-offset.py` — walks a list of transcript IDs, checks every video part, and logs results to `docs/plans/`. Run in the pipeline venv. |
| `sync-design.js` | One-way design-system sync: copies shared CSS files verbatim from `tm-static` into this repo. `npm run sync-design` (`-- --check` to report drift without writing). |
| `test-matching.js` | Compares local D1 keyword-matching output against `data/meetings.db`; writes its report to `docs/plans/TEST-MATCHING-RESULTS.md` (gitignored). |
| `verify-mirrors.js` | Verifies every `mirroredUrl` in `agenda-scraper/data/*.json` serves a real document from the public R2 domain (GET, not HEAD, to avoid stale edge-cache false positives). |
| `verify-offset.py` | Empirically verifies one video offset by downloading a short YouTube audio window, transcribing it, and fuzzy-aligning it against the official transcript. **Pipeline-called** — `archive-meeting.sh` runs it with `--strict`. Run in the pipeline venv. |

Video clip tools (`clip-youtube.sh`, `transcribe-clip.py`, `build-mashup.py`,
`mashup-clips.sh`) moved to `~/tampa-monitor/toolshed/clips/` on 2026-09-09 —
they are editorial, not pipeline. `verify-offset.py` stays here because
`archive-meeting.sh` calls it.

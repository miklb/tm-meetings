# scripts/

Operator tools run by hand from the repo root, unless noted otherwise below.
Node scripts assume `npm install` has been run in this directory; Python
scripts use the pipeline venv (`source pipeline/activate.sh`) unless marked.

| Script | What it does |
|---|---|
| `add-beta-tester.sh` | Adds email(s) to the `beta_testers` table in remote D1, or lists the current beta-tester list, for the notifications registration-gate flow. |
| `audit-video-offsets.py` | Read-only plausibility check of `video_mapping_<TID>.json` offset values against transcript spans and `data/meetings.db`; flags large/zero/missing offsets. **Pipeline-called** — `archive-meeting.sh` runs it with `--strict`. |
| `build-db.js` | Builds `data/meetings.db` (SQLite) from the agenda JSON in `agenda-scraper/data/`. **Pipeline-called** — `npm run build-db`, and directly from `archive-meeting.sh` / `build-site.sh`. |
| `build-mashup.py` | Builds a captioned, labelled, fade-transitioned video mashup from short clips (Whisper captions + ffmpeg overlay + concat). Run in the pipeline venv. |
| `clip-youtube.sh` | Clips a section of a YouTube video (by start/end seconds) without downloading the whole thing, via `yt-dlp` + `ffmpeg` stream-copy. |
| `dispatch-notifications.js` | POSTs to the production `/api/notify` endpoint to send keyword-match notification emails for given meeting id(s). No dry-run — see `preview-dispatch.js` first. |
| `find-speaker-mentions.js` | Scans processed transcript JSON for segments by a given speaker matching a regex; emits a Markdown report with links to the archive page and YouTube timestamp. |
| `mashup-clips.sh` | Concatenates clips into one mashup video, re-encoding to a uniform format so mismatched source encodes join cleanly. |
| `preview-dispatch.js` | Dry-run for `dispatch-notifications.js` — mirrors the matching engine against remote D1 read-only to show who would get what before sending. |
| `run-offset-verification.py` | Driver for `verify-offset.py` — walks a list of transcript IDs, checks every video part, and logs results to `docs/plans/`. Run in the pipeline venv. |
| `sync-design.js` | One-way design-system sync: copies shared CSS files verbatim from `tm-static` into this repo. `npm run sync-design` (`-- --check` to report drift without writing). |
| `test-matching.js` | Compares local D1 keyword-matching output against `data/meetings.db`; writes its report to `docs/plans/TEST-MATCHING-RESULTS.md` (gitignored). |
| `transcribe-clip.py` | Quick sanity transcription of a short clip with faster-whisper; prints timestamped text lines. Run in the pipeline venv. |
| `verify-mirrors.js` | Verifies every `mirroredUrl` in `agenda-scraper/data/*.json` serves a real document from the public R2 domain (GET, not HEAD, to avoid stale edge-cache false positives). |
| `verify-offset.py` | Empirically verifies one video offset by downloading a short YouTube audio window, transcribing it, and fuzzy-aligning it against the official transcript. **Pipeline-called** — `archive-meeting.sh` runs it with `--strict`. Run in the pipeline venv. |

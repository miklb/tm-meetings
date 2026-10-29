# Maintenance: Evaluation & Implementation Plan

Companion to [`MAINTENANCE.md`](../MAINTENANCE.md) (the policy doc). This file
evaluates that plan and turns it into reusable NotePlan checklists under
[`noteplan/`](noteplan/). Mirrors the kit in `toolshed/maintenance/`; the
cross-repo schedule lives in `toolshed/maintenance/UNIFIED-PLAN.md`.

## Evaluation of MAINTENANCE.md

What works:

- The nightly scrape already has a notification path: `nightly-scrape.yml`
  opens a GitHub issue when meaningful agenda changes appear and flags
  "meeting not available" responses. Toolshed's workflows don't have that.
- The dependency inventory is honest about the real npm surface (three
  package dirs, ~15 direct deps) instead of pretending it's small.
- `.python-version` pins the Python target (toolshed adopted the same).

Gaps it didn't cover (addressed by the checklists here):

1. **No operational monitoring slot.** The nightly scrape can fail silently
   — agendas are less data-loss-sensitive than toolshed's 7-day TPD window,
   but a dead scraper still means stale published records with no signal.
   Weekly green-check is the fix.
2. **No trigger mechanism / "last done" tracking.** A policy `.md` never
   pings you. Same NotePlan integration as toolshed (below).
3. **Un-cadenced npm surface.** Three package dirs with a fast-mover
   (`yt-dlp`) need a real
   monthly `npm outdated` / `npm audit` rhythm — cleared to zero findings
   July 2026, needs the cadence to stay there.
4. **Version drift vs. toolshed.** Node was 20 (EOL) vs. 26; Python pins
   disagreed three ways. Both aligned July 2026 (Node 26, Python 3.13).

## Major-version backlog (evaluate quarterly, don't auto-bump)

Logged July 2026 when the patch/minor backlog was cleared:

- ~~`@llamaindex/liteparse` 1.5 → 2.x~~ — dropped Aug 2026: the A/B experiment
  ended with pdf-parse staying the default, and the unused dep carried
  high-severity sharp/libvips CVEs
- `pdf-parse` 1.1 → 2.x — evaluating this could also replace `pdfreader`,
  which needs a `pdf2json: ^4` override in `agenda-scraper/package.json`
  (v3 bundles a vulnerable `@xmldom/xmldom`; don't drop the override).
  Built on `feat/pdf-parse-2` 2026-10-12 (now 29+ commits behind main); held
  2026-10-28, Michael's call. It changes whitespace in stored
  background/summary strings.
- `glob` 13 → 14 (`scripts/`, build-db file globbing). Logged 2026-10-28.

Verification recipe for scraper majors (PDF extraction and the OnBase
cookie session have no unit-test coverage): on a branch, bump, then
`cd agenda-scraper && ./process-agenda.sh <recent date> --skip-mirror --no-sync`
and `git diff` the meeting JSON and agenda Markdown. Identical output means
the parser and the session still work.

Shipped from the deferred list: `better-sqlite3` 13 and `dotenv` 18 (2026-10-12,
proven by `npm run build-db && npm run build-site && npm test`);
`axios-cookiejar-support` 7 and `tough-cookie` 6 (built 2026-10-12, merged
2026-10-28; the re-scrape recipe passed both times).

## Accepted audit residue (re-check monthly)

None as of 2026-10-28. The `site/` `braces` + `sprintf-js` pair logged
2026-10-12 cleared when Eleventy 3.1.7 moved to chokidar 4.

## Implementation plan

Phase 1 — adopt the checklists (one-time, ~10 min):

1. Copy each file from `maintenance/noteplan/` into NotePlan's `@Templates`
   folder. Titles are in each file's frontmatter.
2. Seed the recurring driver tasks in this week's calendar note (or tag with
   *Repeat Extensions* `@repeat(…)` if installed):

   ```
   - [ ] Meetings weekly ops check >2026-07-13 (then every Mon)
   - [ ] Meetings monthly maintenance >2026-08-03 (first Mon)
   - [ ] Meetings quarterly deps >2026-10-05
   - [ ] Meetings annual audit >2026-10-05
   ```

3. When a driver task fires: new note from the matching template, named
   `Meetings <cadence> — YYYY-MM`, work the checklist, archive the note.
   The dated note *is* the "last done" record.

Phase 2 — shrink the manual surface:

- The change-detection issues already automate the "did anything change"
  half of weekly ops; triage is the only manual part.
- `nightly-scrape.yml` also opens an issue on scrape *failure* (title
  "Nightly scrape had failures"; `scripts/nightly-report.sh` treats a failed
  step as meaningful), so workflow health has a signal. A change notice older
  than a week has done its job: close, don't accumulate.

## Template ↔ policy sync

MAINTENANCE.md stays the *why* (policy, version tables, upgrade runbooks).
The NotePlan templates are the *what* (actionable checklists). When a chore
changes, update both — the checklists reference MAINTENANCE.md sections
instead of duplicating runbook detail, to keep drift one-way.

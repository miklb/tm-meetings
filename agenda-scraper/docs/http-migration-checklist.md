# HTTP Scraper Migration Checklist

This checklist tracks the work required to replace the Selenium-based agenda scraper with the new HTTP-first pipeline while preserving current behavior and outputs.

## Phase 1 · Meeting Discovery without Selenium

- [x] Implement `fetchMeetingList` that loads <https://tampagov.hylandcloud.com/221agendaonline/> via axios + cheerio and returns `{ id, type, href }` entries - **Implemented in `lib/http-meeting-scraper.js`**.
- [x] Mirror existing filtering (exclude past meetings, honor CRA vs regular council logic, retain ordering) - **Type detection logic implemented**.
- [x] Cache the fetched HTML to `output/` for troubleshooting (similar to `spike_meeting_*.html`).
- [x] Respect existing CLI switches (`node json-scraper.js`, `json-scraper.js 2666`, `--date`) by bypassing discovery when a meeting ID or date is supplied.
- [ ] Add unit tests or fixtures covering meeting discovery parsing.

## Phase 2 · Reusable HTTP Meeting Fetcher

- [x] Extract the spike logic into a reusable module (e.g., `http-meeting-scraper.js`) exporting `fetchMeeting(meetingId, meetingType, session)` - **Module created at `lib/http-meeting-scraper.js`**.
- [x] Move helpers (`absoluteUrl`, `convertToDirectPDFUrl`, `extractMeetingDate`, Summary Sheet parsers) into shared utilities - **Created `lib/http-utils.js` with all shared helpers**.
- [x] Ensure the module returns the structure expected by `json-scraper.js` (meeting metadata, agenda items, supporting docs, financial summaries) - **Module tested and validated with complete data structure including `rawTitle`, `formattedDate`, and `sourceUrl`**.
- [x] Update `json-scraper.js` to call the HTTP module as default, with `--selenium` flag for fallback - **HTTP is now default engine, Selenium available via `--selenium` flag**.
- [x] Integrate with WordPress conversion pipeline - **HTTP→JSON→WordPress workflow validated with date-based filenames and cleaned content**.
- [ ] Provide regression tests (fixtures or snapshots) to validate a sample meeting output.

## Phase 3 · Hardening & Runtime Resilience

- [x] Add a session manager that bootstraps cookies once and shares the axios client across discovery + item fetches - **Session reuse implemented with `createSession()` in HTTP module**.
- [x] Implement parallel processing with concurrency limits (CONCURRENCY=5) to improve performance - **Batch processing implemented for agenda items**.
- [x] Suppress PDF parser warnings (stderr redirection) for cleaner output - **TT warnings from pdf-parse suppressed**.
- [ ] Implement retry/backoff for agenda item and PDF requests (handle 401/403/5xx gracefully).
- [ ] Add throttling or small delays to avoid hammering Hyland endpoints.
- [x] Align logging with the Selenium flow (per-item progress, counts, missing backgrounds) to preserve operator experience - **HTTP logging matches Selenium format**.
- [ ] Update `README.md` with the HTTP workflow, troubleshooting tips, and the deprecation timeline for Selenium.

## Testing & Tooling

- [x] Extend unit coverage: keep file-number & dollar-amount tests; add `extractMeetingDate`, session manager, and meeting discovery tests - **File-number (`test-file-number-extraction.js`) and dollar-amount (`test-dollar-extraction.js`) tests complete**.
- [ ] Add `extractMeetingDate` unit tests.
- [ ] Add session manager tests.
- [ ] Add meeting discovery tests.
- [ ] Create a CLI smoke test that replays saved HTML/PDF fixtures without network access (useful for CI).
- [ ] Document or script an agenda diff command to compare HTTP output vs Selenium for regression checks.

## Optional Stretch Goals

- [x] Refactor shared helpers into a `lib/` directory consumed by both `json-scraper.js` and `json-to-wordpress.js` - **Completed with `lib/http-utils.js` and `lib/http-meeting-scraper.js`**.
- [x] Add a `--selenium` flag to fallback to Selenium during transition (HTTP is default) - **Completed: HTTP is default, `--selenium` flag implemented**.
- [x] Integrate HTTP scraper with staff report parsing and WordPress output - **End-to-end HTTP→JSON→WordPress pipeline validated**.
- [ ] Integrate OpenGov API lookups keyed off account codes extracted from Summary Sheets (future enhancement).
- [ ] Remove Selenium dependencies and cleanup legacy code once HTTP path proves stable.

---

**Status Legend:**

- ☐ Not started
- ☑ Completed
- ◪ In progress (replace with partial text as you work)

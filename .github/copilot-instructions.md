# Copilot Instructions for Tampa Meetings

This document provides context and guidelines for AI assistants working on this codebase.

---

## Project Overview

**Tampa Meetings** is a civic transparency tool that scrapes, processes, and publishes Tampa City Council meeting records. It combines:

1. **Agenda Scraper** (Node.js) — Extracts structured data from Hyland OnBase meeting system
2. **Transcript Processor** (Python) — Converts ALL CAPS transcripts to sentence case with NER
3. **Static Site** (Eleventy) — Generates accessible HTML pages
4. **API** (Cloudflare D1, post-launch) — Serves meeting data as JSON via `site/functions/api/*`

---

## Key Technical Decisions

### Architecture

| Component   | Technology       | Why                                |
| ----------- | ---------------- | ---------------------------------- |
| Static Site | Eleventy         | Simple, fast, template flexibility |
| API         | Cloudflare D1 (post-launch) | Serverless, no VPS ops; replaced an earlier Datasette plan |
| Hosting     | Cloudflare Pages | Free, global CDN                   |
| Documents   | Cloudflare R2    | S3-compatible, free egress         |
| Database    | SQLite           | Single file, portable              |

### Code Patterns

- **Accessibility first** — WCAG 2.2 AA is the primary constraint
- **Semantic HTML** — No divitis; use proper elements
- **Native web components** — Prefer vanilla JS over frameworks
- **Progressive enhancement** — Core content works without JS
- **Small functions** — Keep functions focused and testable

---

## Directory Structure

```
tampa-meetings/
├── agenda-scraper/          # Node.js: OnBase scrape → R2 mirror → Markdown post (lib/ has the parsers)
├── transcript-cleaner/
│   └── processor/           # Python: ALL-CAPS → sentence case, NER, YouTube video/offset sync (src/, scripts/)
├── opengov/                 # Python: OpenGov CoA reconciliation → per-meeting funding manifest
├── pipeline/                # Orchestration: discover.py, archive-meeting.sh, build-site.sh, activate.sh
├── scripts/                 # Root Node scripts: build-db.js, dispatch-notifications.js, verify/audit tools
├── site/                    # Eleventy static site
│   ├── src/                 # Templates, data, styles
│   ├── functions/api/       # Cloudflare Pages Functions (D1-backed API)
│   └── migrations/          # D1 schema migrations
├── data/                    # meetings.db (SQLite, gitignored — rebuild with `npm run build-db`)
├── docs/                    # Documentation, plans/ (gitignored)
└── archive/                 # Retired docs and one-off scripts kept for reference
```

---

## Code Style Guidelines

### JavaScript (Node.js scrapers)

```javascript
// ✅ Good: Small, focused functions
async function fetchMeetingPage(meetingId) {
  const url = buildMeetingUrl(meetingId);
  const response = await fetch(url);
  return response.text();
}

// ✅ Good: Descriptive names
const fileNumberPattern = /[A-Z]{2,4}\d{2}-\d{4}/g;

// ❌ Bad: Magic numbers without context
const delay = 3000;

// ✅ Good: Named constants
const RATE_LIMIT_DELAY_MS = 3000;
```

### Python (processors)

```python
# ✅ Good: Type hints
def process_transcript(text: str, entities: list[Entity]) -> ProcessedTranscript:
    pass

# ✅ Good: Docstrings for complex functions
def extract_chapters(video_id: str) -> list[Chapter]:
    """
    Extract chapter markers from YouTube video description.

    Returns list of Chapter objects with title and timestamp.
    Raises YouTubeAPIError if video not found.
    """
    pass

# ❌ Bad: Bare except
try:
    result = risky_operation()
except:
    pass

# ✅ Good: Specific exceptions
try:
    result = risky_operation()
except RequestException as e:
    logger.error(f"Request failed: {e}")
    raise
```

### HTML/Nunjucks (Eleventy templates)

```html
<!-- ✅ Good: Semantic structure -->
<article class="meeting">
  <header>
    <h1>{{ meeting.title }}</h1>
    <time datetime="{{ meeting.date }}">{{ meeting.date | formatDate }}</time>
  </header>
  <main>
    <section class="agenda">
      <h2>Agenda Items</h2>
      <!-- items -->
    </section>
  </main>
</article>

<!-- ❌ Bad: Div soup -->
<div class="meeting">
  <div class="header">
    <div class="title">{{ meeting.title }}</div>
  </div>
</div>
```

### CSS

```css
/* ✅ Good: Logical properties for RTL support */
.sidebar {
  margin-inline-start: 1rem;
  padding-block: 0.5rem;
}

/* ✅ Good: Custom properties for theming */
:root {
  --color-primary: #1a5f7a;
  --spacing-md: 1rem;
}

/* ❌ Bad: Fixed pixel widths for text containers */
.content {
  width: 800px;
}

/* ✅ Good: Fluid, responsive widths */
.content {
  max-width: 65ch;
  width: 100%;
}
```

---

## Domain Knowledge

### Meeting Types

| Code | Full Name                      | Frequency         |
| ---- | ------------------------------ | ----------------- |
| CC   | City Council                   | Weekly (Thursday) |
| CRA  | Community Redevelopment Agency | Thursdays         |
| EVE  | Evening Session                | Thursday Evening  |
| WS   | Workshop                       | Thursdays         |
| SP   | Special Meeting                | As needed         |

### File Number Format

City uses format like `CRA24-2242`, `CC25-0015`:

- First 2-4 letters: Meeting type
- 2 digits: Year
- 4 digits: Sequential number

```javascript
// Pattern for matching
const FILE_NUMBER_PATTERN = /([A-Z]{2,4})(\d{2})-(\d{4})/;
```

### Document Types

- **Staff Report** — City staff analysis and recommendation
- **Ordinance** — Proposed law change
- **Resolution** — Policy statement
- **Agreement** — Contract or MOU
- **Map/Exhibit** — Supporting visuals (often scanned PDFs)

---

## Keyword Notifications Dispatch

Keyword notifications are **manually triggered from your machine** — they are not part of the nightly scrape and there is no GitHub Action. Dispatch after:
1. The agenda post is published on tampamonitor.com (tm-static; the WordPress post it replaced)
2. The Monday morning newsletter has gone out

### Preview first, then dispatch

`dispatch-notifications.js` has **no dry-run** — it emails every matching verified subscriber. Always preview (read-only against remote D1; mirrors the matching engine and the deployed `REGISTRATION_MODE`):

```bash
node scripts/preview-dispatch.js --meeting-ids=2884,2960
```

It lists who would get which items and each subscriber's zero-match keywords. Noisy or dead keywords are information for Michael to relay — never edit a subscriber's keywords.

```bash
WEBHOOK_SECRET=$(grep '^WEBHOOK_SECRET=' .env | cut -d= -f2-) \
MEETING_IDS=2884,2960 \
WORDPRESS_AGENDA_URL=https://tampamonitor.com/tampa-city-council/agendas/8-27-26-regular-meeting-cra-special-call/ \
node scripts/dispatch-notifications.js
```

For multiple meetings on the same agenda day (e.g., Council + CRA), pass a comma-separated list. The script does **not** load `.env` itself — pass `WEBHOOK_SECRET` inline as above.

`WORDPRESS_AGENDA_URL` (name kept from the WP era) is the post the digest links to — use the tm-static permalink. It is optional (links fall back to the static site) and applies to every meeting in the batch. Re-sending for a meeting requires deleting its rows from `notification_log` (dedupe key is subscriber + item + keyword).

When the worker runs with `ENVIRONMENT="development"` and no `RESEND_API_KEY`, it logs emails instead of sending them; in production both `WEBHOOK_SECRET` and `RESEND_API_KEY` are required (the endpoint fails closed).

### Sponsor slot

Add/remove a sponsor in notification emails by setting Pages Function env vars — no code change required:

| Var | Purpose |
| --- | ------- |
| `SPONSOR_IMAGE_URL` | Absolute URL of banner image (600px wide) |
| `SPONSOR_LINK_URL` | Destination URL |
| `SPONSOR_ALT_TEXT` | Alt text (also used in plain-text fallback) |

Both URL vars must be set; if either is absent the slot is not rendered.

---

## Agenda Pipeline — NEVER Skip Steps

**Always use `process-agenda.sh` to process a meeting. Never run individual scripts directly.**

```bash
cd agenda-scraper && ./process-agenda.sh 2025-11-06
```

This runs in order:
1. `json-scraper.js` — scrapes meeting JSON from OnBase (incl. per-item `section` headers)
2. `mirror-documents.js` — uploads documents to Cloudflare R2 and stamps `mirroredUrl` fields into the JSON
3. `python3 -m opengov.reconcile` — reconciles PROJECTED COSTS rows against the OpenGov CoA and writes `opengov/data/reports/<meetingId>-<date>-funding-manifest.json`
4. `json-to-markdown.js` — generates the tm-static markdown post (`docs/plans/AGENDA-MARKUP.md`) using the mirrored URLs and the funding manifest; writes `agendas/agenda_<date>.md` and updates the post in `$TM_STATIC_POSTS_DIR`

**WordPress generation was retired 2026-07-17.** `json-to-wordpress.js` was deleted 2026-09-07. The markdown emitter (`json-to-markdown.js`) is the sole published output.

**Why this matters:** the four steps feed each other in order. Skipping the mirror step leaves new documents linking to OnBase instead of R2; skipping reconciliation makes the per-item Financial impact sections silently disappear from the output. A standalone `json-scraper.js` run no longer erases `mirroredUrl` stamps or overwrites a good file with an empty scrape (`lib/scrape-guard.js` carries stamps forward, keeps the stored version of any item whose fetch failed, and refuses a 0-item scrape), but it still does not mirror new documents or rebuild the funding manifest.

If you need to regenerate the tm-static markdown post only (JSON + mirrors + manifest already done): `node json-to-markdown.js --date <YYYY-MM-DD>` (matches the existing post by slug and keeps its filename + publish date)

If you need to re-mirror only (JSON already done): `node mirror-documents.js <meetingId>`

If you need to re-reconcile only (JSON already done): `python3 -m opengov.reconcile agenda-scraper/data/meeting_<id>_<date>.json`

If you need to re-parse land-use staff reports only (e.g. after improving `staff-report-parser.js`): `node scripts/reparse-staff-reports.js <meetingId>` — rewrites only the per-item `staffReport` fields (mirrors preserved), then regenerate the post with `node json-to-markdown.js --date <YYYY-MM-DD>`

**Do not run `json-scraper.js <meetingId>` standalone as a way to update a published meeting** — it skips the mirror and reconcile steps. It is safe for its own purposes (a by-id re-scrape keeps stored `mirroredUrl`, `meetingType` and `meetingName`); follow it with `process-agenda.sh <date>` before regenerating the post.

---

## Common Tasks

### Adding a New Meeting Type

There is no single `MEETING_TYPES` constant — detection happens at each stage:

1. `agenda-scraper/lib/http-meeting-scraper.js` — infers `meetingType` (regular/evening/workshop/special/cra) from the OnBase page during scraping
2. `scripts/build-db.js` — `VIDEO_MEETING_TYPE_MAP` maps video-mapping/OnBase type labels to the `meetings.meeting_type` slug; `inferTypeFromItems` and `inferMeetingType` cross-check against file-number prefixes and transcript/video data
3. `transcript-cleaner/processor/src/meeting_type_detector.py` — auto-detects CRA/Workshop/Evening/City Council from transcript text for the video pipeline
4. Update Eleventy filters/templates for display if the new type needs its own badge or label

### Debugging Scrape Failures

1. Check if city site HTML structure changed
2. Look for rate limiting (add delays)
3. Check for JavaScript-rendered content (may need Playwright)

### Rebuilding the Database

1. `npm run build-db` (runs `node scripts/build-db.js`) — reads agenda JSON, processed transcripts, and video mappings; writes `data/meetings.db`
2. Run before `cd site && npm run build` any time the DB is missing or stale (it is gitignored, not committed)

---

## Testing

### Manual Testing Checklist

- [ ] Keyboard navigation works for all interactive elements
- [ ] Screen reader announces content logically
- [ ] Color contrast passes WCAG AA (4.5:1 for text)
- [ ] Site works with JavaScript disabled (core content)
- [ ] PDFs open correctly from R2 links
- [ ] Mobile layout is usable

### Automated Checks

There is no lint script and no test suite. Verification is:

```bash
# Build site (catches template errors)
cd site && npm run build

# Check for accessibility issues
npx pa11y-ci ./site/_site/**/*.html
```

plus the manual testing checklist above.

---

## Python Environment

There are **two separate venvs — never mix them:**

- **Pipeline / transcript / video work** runs from `transcript-cleaner/processor/venv/`. Activate with:

  ```bash
  source pipeline/activate.sh
  ```

  This applies to transcript processing, video pipeline, entity rebuilds, and any `pip install` for that stack. Scripts like `archive-meeting.sh` and `discover.py` auto-activate, but running Python scripts directly (e.g., `python3 src/youtube_fetcher.py` or `python3 scripts/build/process_video.py`) requires manual activation first.
- **OpenGov work** runs from the repo-root `.venv/`. Activate with `source .venv/bin/activate`, then run `python3 -m opengov.<module>` from the repo root. See [.github/instructions/opengov.instructions.md](instructions/opengov.instructions.md).

---

## External Services

| Service          | Purpose            | Credentials Location                              |
| ---------------- | ------------------ | ------------------------------------------------- |
| Cloudflare Pages | Static hosting     | Managed in CF dashboard                           |
| Cloudflare R2    | Document storage   | `S3_*` env vars, `docs.meetings.tampamonitor.com` |
| Cloudflare D1    | API database (post-launch) | Managed in CF dashboard, synced via Wrangler |
| YouTube Data API | Chapter extraction | `YOUTUBE_API_KEY` env var                         |

---

## Video Pipeline

The transcript processor includes a video pipeline that matches YouTube recordings to meetings and calculates time offsets for clickable timestamps.

### Key modules

| Module                                         | Purpose                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/meeting_type_detector.py`                 | Auto-detects CRA / Workshop / Evening / City Council from transcript             |
| `src/youtube_fetcher.py`                       | Searches YouTube Data API, saves `video_mapping_<ID>.json`                       |
| `scripts/build/match_whisper_to_transcript.py` | Whisper-based offset calculation, auto-saves to mapping                          |
| `scripts/build/transcribe_with_whisper.py`     | Standalone Whisper transcription                                                 |
| `src/transcript_gap_detector.py`               | Detects multi-part boundaries from timestamp gaps, saves `transcript_start_time` |

Transcript and video HTML is no longer generated by a standalone script (`src/html_generator.py` was deleted 2026-09-07); the Eleventy site renders transcripts and video directly from `data/meetings.db` (`site/src/_includes/transcript.njk`, `video.njk`).

### Design constraints

- **No `youtube-transcript-api`** — causes IP bans. Use Whisper for offset detection instead.
- **YouTube Data API quota** — ~102 units per meeting (~10,000/day free). Keep searches minimal.
- **yt-dlp rate limiting** — add 5-10s delay between consecutive audio downloads.
- **Speaker names from official transcripts only** — no ML transcript service provides speaker attribution.
- **Multi-part videos** — meetings can have 2-3 videos (morning/afternoon/evening, or streaming interruptions). Each video gets an independent `offset_seconds`.
- **Long intros** — Part 2+ videos may have 10+ minutes of countdown/music before speech. Whisper sample duration must account for this.

### Multi-part video mapping schema

```json
{
  "meeting_id": 2645,
  "meeting_date": "2025-11-13",
  "meeting_type": "CRA",
  "videos": [
    {
      "video_id": "SocxtU6vTKc",
      "part": 1,
      "offset_seconds": 552,
      "transcript_start_time": null,
      "chapters": [...]
    }
  ]
}
```

### Pipeline plan

See `transcript-cleaner/processor/docs/VIDEO_PIPELINE.md` for the full phased plan (all 5 steps complete).

---

## When Making Changes

1. **Check the implementation plan** — See `docs/IMPLEMENTATION_PLAN.md` for architectural decisions
2. **Prioritize accessibility** — This is non-negotiable
3. **Test on real data** — Use actual meeting JSON, not mocks
4. **Keep dependencies minimal** — Prefer standard library over npm packages
5. **Document breaking changes** — Update this file and README

---

## Questions to Ask

Before making significant changes, consider:

1. Does this affect accessibility?
2. Does this change the data schema?
3. Will this break existing meeting pages?
4. Is there a simpler approach?
5. Does this align with the implementation plan?

---

_Last updated: September 7, 2026_

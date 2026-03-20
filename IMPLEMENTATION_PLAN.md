# Tampa Meetings — Implementation Plan

A civic transparency platform for Tampa City Council meeting agendas, transcripts, documents, and video — searchable, accessible, and interconnected.

---

## What's Built

### Agenda Scraper (`agenda-scraper/`)

Fetches structured agenda data from Hyland OnBase. Outputs JSON data files + WordPress block HTML. ~48 meetings scraped (July 2025 – March 2026).

Capabilities: file numbers, titles, backgrounds, documents (with R2 mirroring), locations, coordinates, dollar amounts. Meeting types: Regular, Evening, CRA, Special, Workshop. Preserves `mirroredUrl` across re-scrapes via existing-JSON lookup.

### Transcript Processor (`transcript-cleaner/processor/`)

Converts ALL CAPS realtime captioning transcripts from tampagov.net to sentence-case JSON using GLiNER zero-shot NER. Matches YouTube videos via Data API, calculates playback offsets with Whisper. Generates standalone HTML pages with video-synced timestamps.

27 processed transcripts, 27 video mappings, 27 meetings with HTML output.

### SQLite Database (`data/meetings.db`)

`scripts/build-db.js` imports agenda JSON + transcript/video data → 6 tables (meetings, agenda_items, documents, transcript_segments, videos, video_chapters). Idempotent, ~0.2s rebuild. 63 meetings (Nov 2022 – Mar 2026), 1,385 items, 5,482 documents (5,426 mirrored), 18,117 transcript segments, 42 videos, 302 chapters.

### Eleventy Static Site (`site/`)

Eleventy 3.x with Nunjucks templates. Reads SQLite via `better-sqlite3` at build time. Semantic HTML, accessible skip links, responsive CSS with custom properties. Homepage with date-grouped meeting list + individual meeting detail pages with agenda items, mirrored document links, transcript with speaker turns, and embedded YouTube video with chapter navigation. Agenda drawer slide-out panel with focus trapping. 60 pages generated in ~0.5s.

### Document Mirroring

Cloudflare R2 via custom domain (`docs.meetings.tampamonitor.com`). Integrated into `process-agenda.sh` with `--skip-mirror` flag. Links carry `data-original-url` attribute for provenance.

### Build Pipeline

```
Hyland OnBase ─▶ agenda-scraper (JSON) ─▶ build-db.js (SQLite) ─▶ Eleventy (HTML)
                        │
                        └─▶ mirror-documents.js (R2)
```

**Local workflow:**

```
./pipeline/discover.py --process        # scrape + capitalize + video + DB + site
./pipeline/build-site.sh                # DB rebuild + Eleventy only
./pipeline/process-meeting.sh 2653 2026-01-22   # single meeting
```

Run: `node scripts/build-db.js && cd site && npx eleventy`

---

## Architecture

| Component   | Technology              | Status                      |
| ----------- | ----------------------- | --------------------------- |
| Static Site | Eleventy 3.x            | Running locally, 61 pages   |
| Database    | SQLite + better-sqlite3 | Full data (63 meetings)     |
| Documents   | Cloudflare R2           | Operational (5,389 docs)    |
| Hosting     | Cloudflare Pages        | Deployed (`tampa-meetings`) |
| Search      | Pagefind                | Not yet added               |
| API         | D1 + Workers            | Post-launch                 |

### Data Flow (Target)

```
Hyland OnBase ─▶ Agenda Scraper (Node.js) ──┐
                                              ├──▶ SQLite DB ──▶ Eleventy Build ──▶ Static HTML
tampagov.net ──▶ Transcript Processor (Py) ──┘
```

---

## Database Schema

### Current (implemented in `scripts/build-db.js`)

```sql
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,          -- OnBase meeting ID
  date TEXT NOT NULL,
  meeting_type TEXT NOT NULL,      -- 'regular', 'evening', 'cra', 'workshop', 'special'
  title TEXT,
  agenda_type TEXT,                -- 'DRAFT' or 'FINAL'
  source_url TEXT,
  item_count INTEGER DEFAULT 0
);

CREATE TABLE agenda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  item_number INTEGER,
  agenda_item_id TEXT,
  file_number TEXT,
  title TEXT,
  background TEXT,
  location TEXT,
  coordinates TEXT,                -- JSON string
  dollar_amounts TEXT,             -- JSON array string
  fiscal_expenditures REAL DEFAULT 0,
  fiscal_revenues REAL DEFAULT 0,
  fiscal_net REAL DEFAULT 0
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id),
  title TEXT,
  source_url TEXT,
  mirrored_url TEXT,
  original_text TEXT
);
```

### Transcript + video tables (implemented)

```sql
CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  segment_index INTEGER NOT NULL,
  timestamp TEXT,                  -- wall-clock time e.g. "9:06:03AM"
  speaker TEXT,
  text TEXT
);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  youtube_id TEXT NOT NULL,
  title TEXT,
  part INTEGER DEFAULT 1,
  duration TEXT,                   -- ISO 8601 e.g. "PT3H7M21S"
  offset_seconds INTEGER DEFAULT 0,
  transcript_start_time TEXT       -- wall-clock resume for part 2+
);

CREATE TABLE video_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id),
  title TEXT,
  timestamp TEXT,                  -- "HH:MM:SS"
  seconds INTEGER
);
```

### Future tables (not immediate priority)

- **`entities`** — canonical entity names from NER (person, org, location, file_number)
- **`document_versions`** — change tracking with SHA256 hashing
- **FTS5 virtual tables** — full-text search on agenda items, transcripts, documents (local SQLite only — D1 does not support FTS5; user-facing search handled by Pagefind)

---

## Completed: Transcript + Video Integration

Imported transcript and video data into SQLite; the Eleventy site renders them alongside agendas with speaker turns, clickable YouTube timestamps, and chapter navigation.

### Data available

| Source                | Files         | Location                                                 |
| --------------------- | ------------- | -------------------------------------------------------- |
| Processed transcripts | 14 JSON files | `transcript-cleaner/processor/data/processed/`           |
| Video mappings        | 12 JSON files | `transcript-cleaner/processor/data/video_mapping_*.json` |

### Transcript JSON shape

```json
{
  "meeting_id": "2645",
  "meeting_date_time": "THURSDAY, NOVEMBER 13, 2025, 9:00 A.M.",
  "segments": [
    {
      "timestamp": "9:06:03AM",
      "speaker": "Lynn Hurtak",
      "text": "Good morning..."
    }
  ],
  "segment_count": 651
}
```

### Video mapping JSON shape

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
      "chapters": [
        { "title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0 }
      ]
    }
  ]
}
```

### Step 1: Meeting ID alignment ✅

The agenda system (OnBase) and transcript system (tampagov.net) use **different meeting IDs**. The `meetings` table uses OnBase IDs as the primary key.

- [x] Add `transcript_source_id TEXT` column to `meetings` table
- [x] Infer meeting type from: video mapping `meeting_type` (priority) → transcript title text → time-of-day in `meeting_date_time` → default `'regular'`
- [x] Type mapping: video mapping `"City Council"` → `'regular'`, `"CRA"` → `'cra'`, `"Workshop"` → `'workshop'`, `"Evening"` → `'evening'`
- [x] Date extracted from filename (`processed_transcript_{id}_{YYYY-MM-DD}.json`) — more reliable than parsing `meeting_date_time`
- [x] 8 transcripts matched to agenda meetings (Oct 2025 – Feb 2026)
- [x] 5 stub rows created for 2022–2023 transcripts with no agenda data (synthetic IDs: `1_000_000 + transcript_id`)
- [x] Rebuilt DB with all years: 57 meetings, 1378 items, 5321 documents

**Known gap resolved in Step 2:** Transcript 2645 (2025-11-13 CRA meeting) had no type indicators — fixed with `TRANSCRIPT_TYPE_OVERRIDES = { '2645': 'cra' }` in `build-db.js`. Now correctly matches meeting 2648 (CRA, 2025-11-13).

### Step 2: Add tables + import logic to `build-db.js` ✅

- [x] Add `transcript_segments`, `videos`, `video_chapters` table creation to schema
- [x] Add `TRANSCRIPT_TYPE_OVERRIDES = { '2645': 'cra' }` to fix CRA meeting type inference
- [x] Read processed transcripts from `transcript-cleaner/processor/data/processed/processed_transcript_*.json`
- [x] For each transcript: resolve meeting ID via `transcript_source_id`, insert segments with `segment_index` for ordering
- [x] Read video mappings from `transcript-cleaner/processor/data/video_mapping_*.json`
- [x] For each video: insert into `videos`, then insert each chapter into `video_chapters`

**Results:** 18,117 segments across 27 meetings · 42 videos · 302 chapters

### Step 3: Update Eleventy data layer ✅

- [x] Expand `all` query to include all meetings with content (agenda items or transcript), not just 2026+
- [x] Add `has_transcript` and `has_video` flags (0/1) to `all` via subqueries
- [x] Add `stmtSegments` prepared statement: `SELECT segment_index, timestamp, speaker, text FROM transcript_segments WHERE meeting_id = ? ORDER BY segment_index`
- [x] Add `stmtVideos` + `stmtChapters` prepared statements; nest chapters as `video.chapters[]`
- [x] Attach `transcript_segments` and `videos` arrays to each `details[id]` object
- [x] Add `badge--transcript` and `badge--video` CSS classes to `style.css`
- [x] Show Transcript/Video badges on homepage `index.njk`
- [x] Fixed front matter in `index.njk` and `meeting.njk` (was collapsed to single line)

**Results:** Homepage now shows 57 meetings (2022–2026); transcript/video badges visible; `detail.videos[i].chapters` available in templates

### Step 4: Transcript template ✅

- [x] Create `site/src/_includes/transcript.njk`
  - Collapsible `<details>` / `<summary>` with segment count
  - Speaker-grouped turns: each new speaker opens a `.transcript-turn` div with `.transcript-speaker` heading
  - Segment timestamps shown as `<span>` (no video) or `<a href="https://youtu.be/{id}?t={sec}">` (with video)
  - `aria-label="Watch at {timestamp}"` on timestamp links
  - Full text works without JavaScript (progressive enhancement)
- [x] Add `youtubeUrl` filter to `eleventy.config.js`
  - Parses wall-clock timestamps (`9:15:50AM` → seconds since midnight)
  - Selects correct video part by matching `transcript_start_time ≤ segment time`
  - Applies `offset_seconds + (segSec − startSec)` to get YouTube position
- [x] Include `transcript.njk` in `meeting.njk` after agenda items
- [x] Add transcript/video badges to meeting detail page `<header>`
- [x] Add transcript CSS: collapsible panel, speaker names, monospace timestamps, scrollable body (`max-height: 60vh`)
- [x] Fixed `index.njk` and `meeting.njk` front matter (single-line YAML → multi-line)

**Verified:** Meeting 2608 generates 914 transcript lines; YouTube links correctly open at offset (e.g., `?t=614` for 9:06:53AM in part 1)

### Step 5: Video section ✅

- [x] Create `site/src/_includes/video.njk`
  - Privacy-friendly `<iframe src="youtube-nocookie.com/embed/{id}">` with `loading="lazy"`
  - Plain `Watch on YouTube ↗` link always visible as fallback
  - Multi-part support: each video gets its own `<div class="video-part">` with "Part N" heading
  - Collapsible chapter list (`<details>`) with timestamp links (`https://youtu.be/{id}?t={seconds}`)
  - Section omitted entirely when `detail.videos` is empty
- [x] Include `video.njk` in `meeting.njk` between agenda items and transcript
- [x] Add video CSS: responsive 16:9 embed wrapper, chapter list with monospace timestamps
- [x] Fixed `index.njk` front matter permanently by moving layout/title to `index.11tydata.json` sidecar (formatter was collapsing multi-line YAML back to single line on every save)

**Verified:** Meeting 2608 outputs 30 video/chapter elements; youtube-nocookie embed + chapter links with `?t=` offsets; meeting 2785 (no video) has zero `.video-section` elements

### Verification ✅

- [x] `meetings.db` contains transcript segments for all matched meetings (10,883 segments)
- [x] Meeting detail pages show transcript below agenda (collapsible, with speaker turns)
- [x] Video timestamps link to correct YouTube positions (wall-clock → offset calculation)
- [x] Homepage badges distinguish meetings with/without transcripts and video
- [x] Unmatched historical transcripts accessible as standalone pages (stub IDs 1002435–1002450)

---

## Later: Launch Preparation

These are needed to go live at `meetings.tampamonitor.com` but are not blocking local development.

### Repository + Deployment

- [x] Create GitHub repo — `miklb/tm-meetings` (private)
- [x] Consolidate code into unified directory structure — `pipeline/` orchestration scripts
- [x] Configure `meetings.tampamonitor.com` DNS in Cloudflare
- [x] Set up Cloudflare Pages project and first deploy — `wrangler pages deploy site/_site --project-name tampa-meetings`
- [ ] Keep WordPress output in parallel until subdomain replaces it

### Pipeline (`pipeline/`)

Consolidated orchestration tier that bridges the three codebases (agenda-scraper, transcript-processor, Eleventy site) into reproducible local workflows.

- [x] `transcript_lookup.py` — Scrapes tampagov index, resolves `(date, meeting_type) → transcript pkey`, matches against OnBase IDs in SQLite
- [x] `discover.py` — Compares transcript index against processed data, reports ready-to-process meetings, optionally auto-processes them
- [x] `process-meeting.sh` — End-to-end per-meeting pipeline: scrape → capitalize → video → DB rebuild → site rebuild (idempotent steps)
- [x] `build-site.sh` — Quick DB rebuild + Eleventy
- [x] `rebuild-entities.sh` — Regenerate NER entity databases from agenda data
- [x] `README.md` — Full usage docs with data flow diagram

### Automation

- [ ] GitHub Actions nightly scrape → rebuild DB → trigger CF Pages deploy
- [ ] Manual `workflow_dispatch` trigger
- [ ] Error notifications on failure
- [ ] Incremental builds (only changed meetings)

### Search

- [ ] Pagefind integration with Eleventy build
- [ ] Accessible search results page with filtering by meeting type and date
- [ ] Keyboard-navigable, mobile-friendly UI

### Site Polish

- [ ] Meta tags (OpenGraph, description)
- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] Cross-browser and mobile testing
- [ ] Lighthouse > 90

### Retire WordPress Output

- [ ] Remove WordPress-specific code from agenda scraper
- [ ] Redirect links from WordPress to subdomain
- [ ] Archive `miklb/agenda-scraper` repo

---

## Someday

Features that depend on a stable, launched site.

### D1 + Workers API

Serve meeting data as JSON for external consumers (journalists, civic hackers). Cloudflare D1 as a read-only edge replica of local SQLite, synced after each `build-db.js` run via Wrangler CLI. Workers API at `api.tampamonitor.com` (or `meetings.tampamonitor.com/api/`) with endpoints for meetings, agenda items, documents, transcripts, and text search (`LIKE` queries). $0 on free tier (25B reads/month, 10GB max DB). Replaces earlier Datasette plan — eliminates $7/mo VPS and server maintenance.

**D1 limitation:** No FTS5 support. User-facing full-text search is handled by Pagefind (client-side, indexes static HTML at build time). D1 provides structured queries + basic text matching for API consumers. If `LIKE` search becomes inadequate at scale, evaluate Cloudflare Vectorize + Workers AI for semantic search over document embeddings.

### Document Text Extraction

Extract text from mirrored PDFs (`pdf-parse` + Tesseract OCR fallback). Add `document_text` column to `documents` table in both local SQLite and D1. Render extracted text into meeting detail pages so Pagefind indexes it automatically. API consumers query via D1 `LIKE` on `document_text`.

### Cross-Linking

- YouTube chapter → agenda item mapping by file number
- File number mentions in transcripts → agenda item links
- Speaker attribution across meetings via entity resolution

### Entity Resolution

Unify entity databases from agenda and transcript systems. Track canonical names for people, organizations, locations.

### Document Change Tracking

SHA256 hashing to detect when agenda documents are added or modified between scrapes.

### Historical Backfill

Extend coverage to 2023–2024 meetings. ~100-150 meetings, ~25-37 GB documents, ~$7/year R2 storage.

---

## Reference

### Processing Timeline

| Event                  | Day               | Action                        |
| ---------------------- | ----------------- | ----------------------------- |
| Draft agenda published | Friday            | Scrape, create draft page     |
| Daily monitoring       | Sat–Wed           | Nightly scrape for changes    |
| Meeting occurs         | Thursday          | —                             |
| Transcript available   | Following Tuesday | Scrape, process, publish      |
| Full record published  | Wednesday         | Complete page with transcript |

### Meeting ID Systems

| System                | ID Example | Source                              |
| --------------------- | ---------- | ----------------------------------- |
| Agenda (OnBase)       | `2785`     | Hyland OnBase `meetingId` parameter |
| Transcript (tampagov) | `2645`     | tampagov.net `pkey` parameter       |

Canonical match key: `(date, meeting_type)`. Both systems cover the same meetings but with independent IDs.

### Infrastructure Costs

| Service          | Cost      | Purpose                        |
| ---------------- | --------- | ------------------------------ |
| Cloudflare Pages | $0        | Static site hosting            |
| Cloudflare R2    | ~$0.50/mo | Document storage (operational) |
| Cloudflare D1    | $0        | API database (post-launch)     |
| Workers          | $0        | API endpoints (post-launch)    |

### Decisions Log

| Decision              | Choice                        | Rationale                                                                 |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| Static site generator | Eleventy                      | Simple, fast, template flexibility                                        |
| Data at build time    | SQLite via better-sqlite3     | No runtime API dependency                                                 |
| Search                | Pagefind                      | Zero cost, client-side, static-compatible                                 |
| API                   | D1 + Workers over Datasette   | $0, serverless, no VPS ops; D1 lacks FTS5 but Pagefind covers user search |
| Documents             | Cloudflare R2                 | Operational, custom domain `docs.meetings.tampamonitor.com`               |
| Hosting               | Cloudflare Pages              | Free, global CDN                                                          |
| WordPress output      | Keep until subdomain launches | Current publication method                                                |
| Video archiving       | Not needed                    | Tampa TV retains videos on YouTube                                        |
| Accessibility         | WCAG 2.1 AA minimum           | Non-negotiable first priority                                             |

### Success Metrics

| Metric                  | Target                   |
| ----------------------- | ------------------------ |
| Meeting processing time | < 30 minutes per meeting |
| Search result latency   | < 200ms                  |
| Transcript accuracy     | > 95% proper case        |
| Video sync accuracy     | ± 2 seconds              |
| Lighthouse Performance  | > 90                     |
| WCAG compliance         | AA minimum               |

---

_Last updated: March 20, 2026_

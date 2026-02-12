# Tampa Meetings — Implementation Plan

A unified platform for Tampa City Council meeting agendas, transcripts, documents, and video—searchable, accessible, and interconnected.

---

## Current State

The project consists of two independent, working tools that have **not yet been unified**:

### Agenda Scraper (`agenda-scraper/`)

**Status:** Active, maintained, deployed to GitHub (`miklb/agenda-scraper`)

| Capability     | Details                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| Scraping       | Fetches structured agenda data from Hyland OnBase via HTTP                           |
| Output         | JSON data files + WordPress block markup                                             |
| Data extracted | File numbers, titles, backgrounds, documents, locations, coordinates, dollar amounts |
| Meeting types  | Regular, Evening, CRA, Special, Workshop                                             |
| Automation     | GitHub Actions nightly cron scrapes + auto-commits                                   |
| Publishing     | WordPress block HTML (current publication method)                                    |
| Coverage       | ~48 meetings scraped (July 2025 – February 2026)                                     |

### Transcript Processor (`transcript-cleaner/processor/`)

**Status:** Functional, backed up to private GitHub repo

| Capability      | Details                                                        |
| --------------- | -------------------------------------------------------------- |
| Input           | ALL CAPS transcripts from tampagov.net                         |
| Output          | Sentence-case JSON + static HTML with video sync               |
| Processing      | GLiNER zero-shot NER for entity recognition                    |
| Entity database | Built from multiple sources (holidays, states, Tampa features) |
| Video sync      | YouTube timestamp alignment via Whisper                        |
| Coverage        | 11 meetings processed with HTML output                         |
| Site output     | Standalone HTML pages with search, styles, video links         |

### What Does NOT Exist Yet

- Unified `tampa-meetings` GitHub repository
- Eleventy static site (`site/`)
- Unified data pipeline (`pipeline/`)
- SQLite database (`meetings.db`)
- Document mirroring to Cloudflare R2 (code exists but not deployed)
- Pagefind or FTS5 search
- Meeting ID mapping between systems
- YouTube chapter extraction pipeline
- Document change tracking / versioning
- Entity resolution across both systems

---

## Integration Vision

Each meeting becomes a single source of truth connecting:

```
┌─────────────────────────────────────────────────────────────────┐
│                        MEETING RECORD                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │   AGENDA    │───▶│ TRANSCRIPT  │───▶│   VIDEO SEGMENTS    │ │
│  │   (JSON)    │    │   (JSON)    │    │   (YouTube + sync)  │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│         │                  │                      │             │
│         ▼                  ▼                      ▼             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │  DOCUMENTS  │    │  SPEAKERS   │    │  TIMESTAMP LINKS    │ │
│  │   (PDFs)    │    │  ENTITIES   │    │  (per agenda item)  │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    SEARCH INDEX                           │  │
│  │  Full-text • Entities • Documents • Timestamps           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Cross-Linking Capabilities (Stretch Goal)

These are desirable but not required for launch:

| From               | To                      | Method                                     |
| ------------------ | ----------------------- | ------------------------------------------ |
| Agenda Item        | Transcript Discussion   | File number matching + timestamp detection |
| Transcript Segment | Video Moment            | Calculated offsets per video               |
| Agenda Item        | Supporting Documents    | Direct PDF links                           |
| Speaker Name       | All Their Contributions | Entity recognition across transcripts      |
| File Number        | All Related Meetings    | Cross-meeting search                       |

---

## Technical Architecture

### Stack (MVP)

| Component   | Technology       | Why                                             |
| ----------- | ---------------- | ----------------------------------------------- |
| Static Site | Eleventy         | Simple, fast, template flexibility              |
| Search      | Pagefind         | Zero-cost client-side, works with static output |
| Database    | SQLite           | Single file, portable, read at build time       |
| Hosting     | Cloudflare Pages | Free, global CDN                                |

### Future Stack (Post-Launch)

| Component   | Technology    | Why                                 |
| ----------- | ------------- | ----------------------------------- |
| API         | Datasette     | Auto-generated JSON API from SQLite |
| Full-text   | FTS5          | SQL-level full-text search          |
| Documents   | Cloudflare R2 | S3-compatible, free egress          |
| API Hosting | Vultr VPS     | Full control, SSH access            |

Datasette and R2 become necessary when document mirroring and text extraction are implemented. For MVP, Eleventy reads SQLite directly via `better-sqlite3` at build time.

### Architecture (MVP)

```
┌─────────────────────────────────────────────────────────────────┐
│                    STATIC SITE (Eleventy)                        │
│               meetings.tampamonitor.com                          │
│      Pre-rendered meeting pages + Pagefind search               │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Cloudflare Pages (free)
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      SQLite Database                             │
│              Read at build time via better-sqlite3              │
│        Agenda data + transcript data + FTS5 search              │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Hyland OnBase ─▶ Agenda Scraper (Node.js) ──┐
                                              ├──▶ SQLite DB ──▶ Eleventy Build ──▶ Cloudflare Pages
tampagov.net ──▶ Transcript Processor (Py) ──┘
```

---

## Data Schema

### SQLite Tables

```sql
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  meeting_type TEXT NOT NULL,  -- 'cc', 'cra', 'eve', 'ws', 'sp'
  title TEXT,
  agenda_source_id TEXT,       -- Hyland OnBase ID
  transcript_source_id TEXT,   -- tampagov.net ID
  video_ids TEXT               -- JSON array of YouTube IDs
);

CREATE TABLE agenda_items (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER REFERENCES meetings(id),
  item_number INTEGER,
  file_number TEXT,            -- e.g. 'CRA24-2242'
  title TEXT,
  background TEXT,
  fiscal_impact TEXT,
  location TEXT,
  coordinates TEXT,
  recommendation TEXT
);

CREATE TABLE transcript_segments (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER REFERENCES meetings(id),
  timestamp TEXT,
  speaker TEXT,
  text TEXT,
  video_offset_seconds INTEGER
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  agenda_item_id INTEGER REFERENCES agenda_items(id),
  title TEXT,
  source_url TEXT,
  r2_url TEXT,
  file_hash TEXT,
  file_size INTEGER,
  ocr_text TEXT
);

CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  name TEXT,
  entity_type TEXT,            -- 'person', 'organization', 'location', 'file_number'
  canonical_form TEXT
);

CREATE TABLE videos (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER REFERENCES meetings(id),
  youtube_id TEXT,
  title TEXT,
  duration_seconds INTEGER,
  offset_seconds INTEGER
);

-- Full-text search
CREATE VIRTUAL TABLE agenda_items_fts USING fts5(title, background, content=agenda_items);
CREATE VIRTUAL TABLE transcript_segments_fts USING fts5(speaker, text, content=transcript_segments);
CREATE VIRTUAL TABLE documents_fts USING fts5(title, ocr_text, content=documents);

-- Change tracking
CREATE TABLE document_versions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id),
  version INTEGER,
  scraped_at DATETIME,
  file_hash TEXT,
  change_type TEXT             -- 'added', 'modified', 'removed'
);
```

---

## Target Directory Structure

```
tampa-meetings/
├── .github/
│   ├── workflows/
│   │   └── nightly-scrape.yml
│   └── copilot-instructions.md
│
├── pipeline/
│   ├── scrapers/
│   │   ├── agenda-scraper.js
│   │   ├── transcript-scraper.py
│   │   └── document-mirror.js
│   ├── processors/
│   │   ├── transcript-processor.py
│   │   └── entity-resolver.py
│   ├── scripts/
│   │   ├── build-database.py
│   │   └── deploy-datasette.sh
│   ├── package.json
│   └── requirements.txt
│
├── site/
│   ├── src/
│   │   ├── index.njk
│   │   ├── meetings/
│   │   ├── _includes/
│   │   └── _data/
│   ├── public/
│   ├── eleventy.config.js
│   └── package.json
│
├── data/
│   ├── agendas/
│   ├── transcripts/
│   └── meetings.db
│
├── docs/
│   └── IMPLEMENTATION_PLAN.md
│
├── README.md
├── LICENSE
└── .gitignore
```

---

## Implementation Phases

Phases are ordered by priority and dependency. The primary goal is launching `meetings.tampamonitor.com` with integrated agenda and transcript data.

### Phase 1: Transcript Processor Stabilization

**Goal:** Get the transcript processor fully functional, reliable, and backed up.

**Prerequisites:** None — this is independent work

- [x] Push transcript-cleaner to GitHub (private or public) for backup
- [x] Audit and update `requirements.txt` for Python 3.12+ compatibility
- [x] Verify end-to-end pipeline: scrape → process → generate HTML
- [ ] Process backlog of unprocessed meetings
- [x] Document the workflow (inputs, commands, outputs)
- [ ] Stabilize video sync offset calculation
- [ ] Test NER entity recognition accuracy on recent transcripts

**Deliverable:** Reliable transcript processor with GitHub backup and clear workflow docs

---

### Phase 2: Repository Setup + DNS

**Goal:** Create the unified repository and configure DNS for the meetings subdomain.

**Prerequisites:** Phase 1 (transcript processor stable enough to port)

- [ ] Create `miklb/tampa-meetings` repository on GitHub (public)
- [ ] Initialize with README, LICENSE (MIT), .gitignore
- [ ] Create directory structure (`pipeline/`, `site/`, `data/`, `docs/`)
- [ ] Set up copilot-instructions.md
- [ ] Configure `meetings.tampamonitor.com` DNS in Cloudflare
- [ ] Set up Cloudflare Pages project (even if empty)

**Deliverable:** Repository and DNS ready for site deployment

---

### Phase 3: Port Code to Unified Repo

**Goal:** Move both tools into the unified repository.

**Prerequisites:** Phase 2

- [ ] Port agenda scraper to `pipeline/scrapers/`
  - `lib/http-meeting-scraper.js` → `pipeline/scrapers/agenda-scraper.js`
  - `lib/http-utils.js` → `pipeline/scrapers/http-utils.js`
  - `format-helpers.js` → `pipeline/scrapers/format-helpers.js`
- [ ] **Keep WordPress output code** — still needed for current publication
- [ ] Port transcript processor to `pipeline/processors/`
- [ ] Create `pipeline/package.json` and `pipeline/requirements.txt`
- [ ] Move existing JSON data files to `data/agendas/`
- [ ] Move processed transcript data to `data/transcripts/`
- [ ] Verify both tools run correctly from new locations
- [ ] Update `.env.example`

**Deliverable:** Both tools functional in unified repo, WordPress output preserved

---

### Phase 4: SQLite Database

**Goal:** Create a unified database from existing agenda and transcript data.

**Prerequisites:** Phase 3

- [ ] Write `pipeline/scripts/build-database.py` to create schema
- [ ] Write JSON-to-SQLite import for agenda data (~48 meetings)
- [ ] Write JSON-to-SQLite import for transcript data (~10 meetings)
- [ ] Create FTS5 virtual tables for full-text search
- [ ] Verify data integrity and query performance
- [ ] Add database rebuild script to workflow

**Deliverable:** `data/meetings.db` with agenda + transcript data

---

### Phase 5: Eleventy Static Site (MVP)

**Goal:** Launch the meetings subdomain with agenda and transcript pages.

**Prerequisites:** Phase 4, DNS configured (Phase 2)

- [ ] Initialize Eleventy project in `site/`
- [ ] Create `site/src/_data/meetings.js` reading SQLite via `better-sqlite3`
- [ ] Design and build templates:
  - `base.njk` layout (semantic HTML, skip links, ARIA)
  - `index.njk` homepage with meeting list
  - `meeting.njk` individual meeting page with agenda
  - `agenda-item.njk` partial
  - Transcript section (collapsible, per meeting)
- [ ] Implement responsive CSS (custom properties, logical properties, fluid widths)
- [ ] Add navigation, footer, meta tags
- [ ] Configure Cloudflare Pages auto-deploy on push
- [ ] Accessibility audit (keyboard nav, contrast, headings, screen reader)
- [ ] Cross-browser and mobile testing
- [ ] Performance optimization (Lighthouse > 90)

**Deliverable:** Live site at `meetings.tampamonitor.com`

---

### Phase 6: Automation

**Goal:** Automated scraping, processing, and site rebuilds.

**Prerequisites:** Phase 5

- [ ] Create `.github/workflows/nightly-scrape.yml`
  - Cron at 11 PM EST (4 AM UTC)
  - Manual trigger via `workflow_dispatch`
  - Scrape → update DB → commit → trigger Cloudflare Pages rebuild
- [ ] WordPress output continues in parallel (until subdomain replaces it)
- [ ] Set up error notifications on workflow failure
- [ ] Implement incremental builds (only changed meetings)

**Deliverable:** Self-updating site with nightly scraping

---

### Phase 7: Search

**Goal:** Client-side search across all content.

**Prerequisites:** Phase 5

- [ ] Install and configure Pagefind for Eleventy build
- [ ] Create accessible search results page
- [ ] Style search UI (mobile-friendly, keyboard navigable)
- [ ] Add filtering by meeting type and date

**Deliverable:** Working search across meetings and transcripts

---

### Phase 8: Retire WordPress Output

**Goal:** Once the meetings subdomain is stable, stop generating WordPress markup.

**Prerequisites:** Phase 6 (automation running reliably)

- [ ] Verify meetings subdomain is fully replacing WordPress for agenda publication
- [ ] Remove WordPress-specific code from agenda scraper
- [ ] Update any links/redirects from WordPress to subdomain
- [ ] Archive `miklb/agenda-scraper` repo

**Deliverable:** Single publication path via meetings subdomain

---

## Future Phases (Post-Launch)

These are desirable features that depend on a working meetings subdomain.

### Document Mirroring + Datasette API

**Goal:** Mirror PDFs to R2 and serve data via Datasette for third-party consumers.

- [ ] Deploy document mirroring code to production (R2)
- [ ] Provision Vultr VPS for Datasette
- [ ] Configure Nginx, SSL, systemd for `meetings-api.tampamonitor.com`
- [ ] Implement PDF text extraction (`pdf-parse`)
- [ ] Add Tesseract OCR fallback for scanned documents
- [ ] Index document text in FTS5

This becomes necessary when document mirroring and full-text extraction are priorities.

### YouTube Chapters + Video Sync

**Goal:** Link agenda items to video timestamps.

- [ ] Set up YouTube Data API credentials
- [ ] Build chapter extraction script
- [ ] Map chapters to agenda items by file number
- [ ] Add "jump to discussion" links from agenda items
- [ ] Handle multi-part videos (morning/evening sessions)

### Cross-Linking + Entity Resolution

**Goal:** Cross-reference entities across meetings.

- [ ] Unify entity databases from both systems
- [ ] Implement cross-meeting entity linking (people, organizations)
- [ ] Add "related meetings" suggestions
- [ ] Export search results (CSV/JSON)

### Document Change Tracking

**Goal:** Track when agenda documents are added or modified.

- [ ] Implement document change detection (SHA256 hashing)
- [ ] Create `document_versions` table
- [ ] Build "What's Changed" display on agenda pages

### Historical Backfill (Optional / Sponsored)

**Goal:** Extend coverage to 2023–2024 meetings.

- [ ] Modify scraper for historical date ranges
- [ ] Batch scrape and process historical meetings
- [ ] Verify data quality

**Estimates:** ~100-150 meetings, ~25-37 GB documents, ~$7/year R2 storage

---

## Key Technical Considerations

### Meeting ID Alignment

The agenda system and transcript system use different IDs. Use **date + meeting type** as the canonical identifier with a lookup table mapping both systems.

### Agenda → Transcript Linking (Priority Order)

1. **YouTube Chapters** — City staff creates chapter markers that map to agenda items
2. **File Number Detection** — Search transcript for file number mentions
3. **Chapter-to-Transcript Mapping** — Use chapter timestamps to find segments
4. **Speaker Context** — Track when Chair announces items

### Processing Timeline

| Event                  | Day               | Action                            |
| ---------------------- | ----------------- | --------------------------------- |
| Draft agenda published | Friday            | Initial scrape, create draft page |
| Daily monitoring       | Sat–Wed           | Nightly scrape for changes        |
| Meeting occurs         | Thursday          | —                                 |
| Transcript available   | Following Tuesday | Scrape, process, publish          |
| Full record published  | Wednesday         | Complete page with transcript     |

---

## Infrastructure Costs

### MVP (Launch)

| Service          | Cost   | Purpose             |
| ---------------- | ------ | ------------------- |
| Cloudflare Pages | $0     | Static site hosting |
| **Total**        | **$0** |                     |

### Post-Launch (with document mirroring + API)

| Service             | Cost          | Purpose             |
| ------------------- | ------------- | ------------------- |
| Cloudflare Pages    | $0            | Static site hosting |
| Cloudflare R2       | ~$0.50/mo     | Document storage    |
| Vultr VPS + backups | $7/mo         | Datasette API       |
| **Total**           | **~$7.50/mo** |                     |

---

## Decisions Log

| Decision              | Choice                        | Rationale                                          |
| --------------------- | ----------------------------- | -------------------------------------------------- |
| Static site generator | Eleventy                      | Simple, fast, template flexibility                 |
| Data at build time    | SQLite via `better-sqlite3`   | No runtime API dependency for MVP                  |
| Search                | Pagefind                      | Zero cost, client-side, static-compatible          |
| API (future)          | Datasette                     | Auto-generated JSON from SQLite, when needed       |
| Hosting               | Cloudflare Pages              | Free, global CDN                                   |
| Documents (future)    | Cloudflare R2                 | Free egress with CF Pages, when mirroring is built |
| WordPress output      | Keep until subdomain launches | Current publication method for agendas             |
| Video archiving       | Not needed                    | Tampa TV retains videos on YouTube                 |
| Accessibility         | WCAG 2.1 AA minimum           | Non-negotiable first priority                      |
| Repository            | New unified public repo       | Clean start, civic transparency                    |

---

## Success Metrics

| Metric                  | Target                   |
| ----------------------- | ------------------------ |
| Meeting processing time | < 30 minutes per meeting |
| Search result latency   | < 200ms                  |
| Transcript accuracy     | > 95% proper case        |
| Video sync accuracy     | ± 2 seconds              |
| Lighthouse Performance  | > 90                     |
| WCAG compliance         | AA minimum               |

---

_Last updated: February 11, 2026_

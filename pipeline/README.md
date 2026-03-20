# Pipeline

Consolidated orchestration scripts that tie together the agenda scraper (Node.js), transcript processor (Python), and Eleventy site build into a single, reproducible workflow.

## Prerequisites

| Requirement       | Location                             | Setup                                                                                                 |
| ----------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Python 3.12+ venv | `transcript-cleaner/processor/venv/` | `cd transcript-cleaner/processor && python3 -m venv venv && venv/bin/pip install -r requirements.txt` |
| Node.js 20+       | System                               | `nvm use 20`                                                                                          |
| Site deps         | `site/node_modules/`                 | `cd site && npm install`                                                                              |
| Entity databases  | `transcript-cleaner/processor/data/` | `./pipeline/rebuild-entities.sh`                                                                      |
| YouTube API key   | `$YOUTUBE_API_KEY` env var           | [Google Cloud Console](https://console.cloud.google.com/)                                             |
| FFmpeg + yt-dlp   | System                               | `brew install ffmpeg yt-dlp`                                                                          |

## Quick Start

```bash
# 1. See what's available to process
python3 pipeline/discover.py

# 2. Process a single meeting
./pipeline/process-meeting.sh 2645 2025-11-13

# 3. Or auto-process all new meetings
python3 pipeline/discover.py --process
```

> **Python environment:** The pipeline scripts auto-detect and re-exec under the
> processor venv (`transcript-cleaner/processor/venv/`), so `python3 pipeline/discover.py`
> works without manual activation. You can also source the venv explicitly:
>
> ```bash
> source pipeline/activate.sh   # activates venv, makes `python` available
> python pipeline/discover.py   # now works
> ```

## Scripts

### `discover.py` — Find unprocessed meetings

Scrapes the [tampagov transcript index](https://apps.tampagov.net/cttv_cc_webapp/), compares against the SQLite database, and reports meetings that have transcripts available but haven't been processed yet.

```bash
# List unprocessed meetings
python pipeline/discover.py

# Auto-process all of them
python pipeline/discover.py --process

# Fetch more historical pages
python pipeline/discover.py --pages 5

# Filter to a date
python pipeline/discover.py --date 2026-02-19

# JSON output for scripting
python pipeline/discover.py --json
```

### `process-meeting.sh` — End-to-end single meeting

Chains all pipeline steps for one meeting:

1. **Scrape** — Download ALL CAPS transcript from tampagov.net
2. **Capitalize** — Convert to sentence case with NER (2-5 min, loads GLiNER)
3. **Video** — YouTube search → Whisper offset → gap detection
4. **Database** — Rebuild SQLite from all agenda + transcript data
5. **Site** — Regenerate Eleventy HTML

```bash
# Full pipeline
./pipeline/process-meeting.sh 2645 2025-11-13

# Skip video step (no YouTube key, or video not posted yet)
./pipeline/process-meeting.sh 2645 2025-11-13 --skip-video

# Skip site rebuild (batch processing — rebuild once at end)
./pipeline/process-meeting.sh 2645 2025-11-13 --skip-site

# Override meeting type
./pipeline/process-meeting.sh 2645 2025-11-13 --meeting-type CRA

# Preview without executing
./pipeline/process-meeting.sh 2645 2025-11-13 --dry-run
```

Each step is **idempotent** — if the output file already exists, that step is skipped.

### `transcript_lookup.py` — Transcript ID resolver

Scrapes the tampagov transcript index to build a mapping of `(date, meeting_type) → transcript pkey`. Used by `discover.py` and can also be used standalone.

```bash
# List recent transcripts
python pipeline/transcript_lookup.py

# Find transcript pkey for a specific date
python pipeline/transcript_lookup.py --date 2026-02-19

# Match against OnBase meetings in DB
python pipeline/transcript_lookup.py --match-db

# Show only unprocessed
python pipeline/transcript_lookup.py --unprocessed

# JSON output
python pipeline/transcript_lookup.py --json
```

### `build-site.sh` — Rebuild database and site

Quick rebuild without re-processing transcripts. Use after manual edits to agenda data or templates.

```bash
./pipeline/build-site.sh              # Full rebuild
./pipeline/build-site.sh --db-only    # Database only
./pipeline/build-site.sh --year 2026  # Filter to year
./pipeline/build-site.sh --deploy     # Rebuild + deploy to Cloudflare Pages
```

### `rebuild-entities.sh` — Update entity databases

Regenerates the NER entity databases from current agenda data. Run this when new agendas are scraped so the capitalizer recognizes new people, organizations, and acronyms.

```bash
./pipeline/rebuild-entities.sh
```

## Data Flow

```
tampagov.net         OnBase (Hyland)
  │ transcript         │ agenda
  │ pkey=2645          │ id=2785
  ▼                    ▼
┌──────────┐    ┌──────────────┐
│ scrape   │    │ agenda-scraper│
│ (Python) │    │ (Node.js)    │
└────┬─────┘    └──────┬───────┘
     │                 │
     ▼                 ▼
  transcript_       data/*.json
  2645_date.json       │
     │                 │
     ▼                 │
┌──────────┐           │
│capitalize│           │
│ (GLiNER) │           │
└────┬─────┘           │
     │                 │
     ▼                 │
  processed_           │
  transcript_          │
  2645_date.json       │
     │                 │
     ▼                 │
┌──────────┐           │
│ video    │           │
│(Whisper) │           │
└────┬─────┘           │
     │                 │
     ▼                 ▼
┌─────────────────────────┐
│ build-db.js             │
│ match by (date, type)   │
│ → meetings.db           │
└───────────┬─────────────┘
            │
            ▼
      ┌──────────┐
      │ Eleventy │
      │ → _site/ │
      └────┬─────┘
           │
           ▼
    ┌──────────────┐
    │ wrangler     │
    │ pages deploy │
    └──────────────┘
```

## Meeting ID Systems

The project uses two separate ID systems:

- **OnBase ID** — From Hyland agenda system (e.g., `2785`). Used for agenda JSON filenames.
- **Transcript pkey** — From tampagov.net (e.g., `2645`). Used for transcript filenames.

These are matched in `build-db.js` by `(date, meeting_type)` key. The `transcript_lookup.py` script automates this discovery.

## Typical Workflows

### After a Thursday meeting

```bash
# 1. Scrape new agenda (if not already done)
cd agenda-scraper && node json-scraper.js

# 2. Discover and process new transcript
python pipeline/discover.py --process

# 3. Deploy to Cloudflare Pages
wrangler pages deploy site/_site --project-name tampa-meetings
```

### Historical backfill

```bash
# Fetch 10 pages of transcript index (~150 meetings)
python pipeline/discover.py --pages 10 --process --skip-video
```

### Just rebuild the site

```bash
./pipeline/build-site.sh

# Rebuild and deploy in one step
./pipeline/build-site.sh --deploy
```

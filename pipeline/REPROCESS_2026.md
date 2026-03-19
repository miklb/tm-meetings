# Reprocessing All 2026 Meetings

Step-by-step runbook for a full refresh of all 2026 meeting data: agendas, documents, transcripts, and site rebuild.

**Estimated time:** 45–90 minutes (most is transcript capitalization at ~3 min per meeting)

> **Note:** The agenda scraper (`json-scraper.js`) only fetches meetings for the current week by default. To re-scrape all 2026 meetings, you must pass each OnBase meeting ID individually. The `reprocess-2026.sh` script automates this by pulling IDs from the SQLite database.

## Scripted Full Run

```bash
# Full reprocess: scrape all agendas → mirror docs → rebuild entities → process transcripts → build site
./pipeline/reprocess-2026.sh

# Preview what would happen
./pipeline/reprocess-2026.sh --dry-run

# Just re-scrape agendas (no mirror/transcripts/build)
./pipeline/reprocess-2026.sh --scrape-only

# Skip document mirroring (no R2 credentials needed)
./pipeline/reprocess-2026.sh --skip-mirror

# Skip transcript processing
./pipeline/reprocess-2026.sh --skip-transcripts

# Pull IDs from JSON files instead of database
./pipeline/reprocess-2026.sh --from-json
```

## Prerequisites

```bash
# Ensure you're in the project root
cd /path/to/meetings

# Python venv ready (pipeline scripts auto-activate, but verify)
transcript-cleaner/processor/venv/bin/python --version

# Node deps installed for agenda scraper
cd agenda-scraper && npm install && cd ..

# Site deps installed
cd site && npm install && cd ..

# R2 credentials set (for document mirroring)
# These should be in agenda-scraper/.env or exported:
#   S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY

# YouTube API key (for video matching)
export YOUTUBE_API_KEY=your-key
```

---

## Phase 1: Update Agendas

The scraper only fetches the current week from OnBase by default. To re-scrape all 2026 meetings, iterate through IDs from the database or JSON files.

### Get meeting IDs

```bash
# From database
sqlite3 data/meetings.db "SELECT id, date, meeting_type FROM meetings WHERE date >= '2026-01-01' ORDER BY date"

# From JSON files
ls agenda-scraper/data/meeting_*_2026-*.json | sed 's/.*meeting_\([0-9]*\)_.*/\1/'
```

### Scrape individual meetings

```bash
cd agenda-scraper

# Scrape a single meeting by OnBase ID
node json-scraper.js 2785

# Scrape all 2026 meetings (loop)
for id in $(sqlite3 ../data/meetings.db "SELECT id FROM meetings WHERE date >= '2026-01-01'"); do
    echo "Scraping $id..."
    node json-scraper.js "$id"
done
```

**Output:** `agenda-scraper/data/meeting_<id>.json` for each meeting

**Duration:** ~5–10 minutes for all meetings (rate-limited HTTP requests)

---

## Phase 2: Mirror Documents to R2

Upload all supporting documents (PDFs, etc.) to Cloudflare R2. Skips files already uploaded unless `--force` is used.

```bash
cd agenda-scraper

# Mirror all meetings
node mirror-documents.js --all

# Or mirror a specific date
node mirror-documents.js --date 2026-01-22

# Preview without uploading
node mirror-documents.js --all --dry-run

# Force re-upload everything
node mirror-documents.js --all --force
```

**Requires:** `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` in `.env` or environment

**Duration:** Depends on document count; ~10–20 minutes for full 2026 set

---

## Phase 3: Rebuild Entity Databases

Update the NER entity databases so the transcript capitalizer knows about any new people, organizations, or acronyms from the refreshed agendas.

```bash
./pipeline/rebuild-entities.sh
```

**Duration:** ~30 seconds

---

## Phase 4: Process Transcripts

### Option A: Auto-discover and process all new transcripts

```bash
# See what's available
python3 pipeline/discover.py

# Process all unprocessed meetings (skips already-done ones)
python3 pipeline/discover.py --process

# Skip video matching if YouTube key isn't set
python3 pipeline/discover.py --process --skip-video
```

### Option B: Reprocess specific meetings

Use the transcript lookup to find pkeys, then process individually:

```bash
# Find transcript pkeys for 2026 meetings
python3 pipeline/transcript_lookup.py --match-db

# Process a specific meeting (pkey + date)
./pipeline/process-meeting.sh 2661 2026-02-26
./pipeline/process-meeting.sh 2660 2026-02-19
./pipeline/process-meeting.sh 2653 2026-01-22
```

### Option C: Reprocess ALL 2026 transcripts (force re-capitalize)

To force reprocessing of meetings that were already done, remove their processed files first:

```bash
# List what exists
ls transcript-cleaner/processor/data/processed/

# Remove processed files to force re-capitalize
# (raw transcripts are preserved — only the capitalized output is removed)
rm transcript-cleaner/processor/data/processed/processed_transcript_26*.json

# Now discover.py will see them as unprocessed
python3 pipeline/discover.py --process
```

**Duration:** ~3–5 minutes per meeting for capitalization (GLiNER model loading)

---

## Phase 5: Rebuild Database and Site

If you used `discover.py --process`, the site is rebuilt automatically at the end. Otherwise:

```bash
# Rebuild database + Eleventy site
./pipeline/build-site.sh

# Or just the database
./pipeline/build-site.sh --db-only

# Filter to 2026 only
./pipeline/build-site.sh --year 2026
```

**Duration:** <5 seconds

---

## What `reprocess-2026.sh` Does

The script automates all five phases in sequence:

1. **Collects IDs** — Queries `meetings.db` for all 2026 OnBase meeting IDs (or reads from JSON filenames with `--from-json`)
2. **Scrapes each** — Runs `node json-scraper.js <id>` for every meeting individually
3. **Mirrors docs** — Runs `node mirror-documents.js` with all IDs at once
4. **Rebuilds entities** — Runs `rebuild-entities.sh` to update NER databases
5. **Processes transcripts** — Runs `discover.py --process` to find and capitalize new transcripts
6. **Builds site** — Runs `build-site.sh` to rebuild DB + Eleventy

---

## Verification

After a full reprocess, check the results:

```bash
# Database stats
./pipeline/build-site.sh --db-only

# Check a specific meeting page
open site/_site/meetings/2785/index.html

# Serve locally
cd site && npx @11ty/eleventy --serve
```

---

## JSON Output for Scripting

The pipeline tools support `--json` output for integration with other scripts:

```bash
# Get unprocessed meetings as JSON
python3 pipeline/discover.py --json

# Get transcript index as JSON
python3 pipeline/transcript_lookup.py --json

# Get matched meetings with OnBase IDs as JSON
python3 pipeline/transcript_lookup.py --match-db --json

# Example: pipe to jq to get just pkeys
python3 pipeline/discover.py --json | jq '.[].pkey'
```

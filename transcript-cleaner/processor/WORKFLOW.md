# Transcript Processing Workflow

How to process Tampa City Council meeting transcripts and match them to YouTube video recordings.

## Overview

The pipeline has two phases:

1. **Transcript processing** — Scrape raw ALL CAPS transcript, convert to sentence case with NER
2. **Video matching** — Find YouTube videos, calculate time offsets via Whisper, detect multi-part gaps

For day-to-day use, `pipeline/process-meeting.sh` runs the entire pipeline end-to-end. For batch discovery of new meetings, use `pipeline/discover.py`.

## Environment Setup

All Python code runs from a single venv at `transcript-cleaner/processor/venv/`. **Always activate before running any command below.**

```bash
# From project root
source pipeline/activate.sh
cd transcript-cleaner/processor

# Or directly
cd transcript-cleaner/processor
source venv/bin/activate
```

Verify: `python3 -c "import dotenv, gliner; print('ok')"`

### Prerequisites

- Python 3.12+
- `YOUTUBE_API_KEY` environment variable (in `.env` or exported)
- OpenAI Whisper, yt-dlp, and FFmpeg installed
- GLiNER model (auto-downloads on first run, ~100MB)

## Quick Start

### Process a single meeting (end-to-end)

```bash
# From project root, with venv activated
./pipeline/process-meeting.sh <pkey> <date>
```

This runs scrape → capitalize → video pipeline → rebuild DB → rebuild site. Use `--skip-video` to skip video offset matching, or `--skip-site` to skip DB/site rebuild.

### Discover and process new meetings

```bash
python3 pipeline/discover.py             # list unprocessed meetings
python3 pipeline/discover.py --process   # auto-process all discovered meetings
```

## Manual Steps

When you need finer control, run each step individually. All commands assume working directory is `transcript-cleaner/processor/` with venv activated.

### 1. Scrape Transcript

Downloads the official transcript from tampagov.net in ALL CAPS format.

```bash
python3 src/scraper.py <pkey> <date>
```

**Output:** `data/transcripts/transcript_<pkey>_<date>.json`

### 2. Capitalize Transcript

Converts ALL CAPS to sentence case using entity databases and GLiNER NER model. Takes 2–5 minutes (model loading + NER on each segment).

```bash
python3 src/capitalize_transcript.py \
  data/transcripts/transcript_<id>_<date>.json \
  data/processed/processed_transcript_<id>_<date>.json
```

### 3. Video Pipeline (unified)

Finds YouTube videos, calculates Whisper offsets, and detects multi-part gaps in one command. This is what `process-meeting.sh` calls internally for the video phase.

```bash
python3 scripts/build/process_video.py <pkey> <date>
```

**What it does (in order):**

1. Locates the processed transcript (falls back to raw if needed)
2. Auto-detects meeting type (CRA, Workshop, Evening, City Council)
3. Searches YouTube for matching videos; creates `data/video_mapping_<id>.json`
4. For multi-part meetings: detects transcript gaps and saves `transcript_start_time` to the mapping — this must happen before offset matching so Part 2+ uses the correct transcript baseline
5. For each video part: calculates a smart audio sample window, transcribes with Whisper, matches to official transcript, and saves `offset_seconds` to the mapping
6. Prints a summary

**Options:**

| Flag                  | Default     | Purpose                                                 |
| --------------------- | ----------- | ------------------------------------------------------- |
| `--meeting-type TYPE` | auto-detect | Override: CRA, Workshop, Evening, City Council          |
| `--model NAME`        | `base`      | Whisper model: tiny, base, small, medium                |
| `--min-gap N`         | 60          | Gap detection threshold in minutes                      |
| `--dry-run`           | off         | Show plan without making API calls or downloading audio |
| `--skip-fetch`        | off         | Use existing video mapping only (no YouTube API call)   |

**Output:** `data/video_mapping_<id>.json` with `offset_seconds` and (for multi-part) `transcript_start_time` populated.

### 4. Rebuild Database and Site

After processing transcripts and/or video mappings, rebuild the SQLite database and Eleventy site so changes appear on the published site. This is automatic when using `process-meeting.sh`, but must be run manually when you've processed videos individually or fixed data by hand.

```bash
# From project root
./pipeline/build-site.sh              # Rebuild DB + site
./pipeline/build-site.sh --db-only    # Rebuild DB only
./pipeline/build-site.sh --year 2026  # Only import 2026 meetings

# Or run each step directly
node scripts/build-db.js              # Rebuild SQLite from JSON + video mappings
cd site && npx @11ty/eleventy         # Regenerate HTML pages
```

`build-db.js` reads processed transcripts and `video_mapping_*.json` files, imports them into `data/meetings.db`, and links videos to meetings via `transcript_source_id`. The Eleventy build then reads from the database to generate meeting pages with embedded video players.

## How Offset Matching Works

### Smart audio sampling

Rather than always downloading 10 minutes from the start, `calculate_smart_duration()` picks a targeted window:

- **Part 1:** Estimates when speech starts based on meeting schedule (morning meetings start later due to pre-roll/ceremonies). Skips ahead if speech likely starts after 10 minutes. Falls back to chapter data if available.
- **Part 2+:** Skips countdown/music pre-roll entirely. Jumps to 2 minutes before the first content chapter marker and captures 5 minutes.

### Candidate filtering

Whisper segments pass through three filters before matching:

- `no_speech_prob ≤ 0.5` — skip segments Whisper flags as likely non-speech
- `≥ 85% ASCII` — catch garbled/hallucinated non-English text from silent sections
- `≥ 4 content words` — after stop word removal, need enough substance to match

### Matching and cross-validation

Each candidate is scored against official transcript segments using 3-gram overlap. When multiple candidates match, their implied offsets are clustered (±30s tolerance), and the cluster with the most independent supporting candidates wins.

### Part 2+ baseline adjustment

For Part 2+ videos, the matcher filters official transcript segments to only those at or after `transcript_start_time` and uses that as the time baseline. Without this, the offset math would use morning session timing for an afternoon video.

## Directory Structure

```
transcript-cleaner/processor/
├── src/                              # Source modules
│   ├── scraper.py                    # Scrapes transcripts from tampagov.net
│   ├── capitalize_transcript.py      # ALL CAPS → sentence case with NER
│   ├── meeting_type_detector.py      # Auto-detects CRA/Workshop/Evening/CC
│   ├── youtube_fetcher.py            # YouTube Data API search
│   ├── transcript_gap_detector.py    # Detects multi-part boundaries
│   └── html_generator.py            # Generates HTML with video timestamps
├── scripts/build/
│   ├── process_video.py              # Unified video pipeline
│   ├── match_whisper_to_transcript.py # Whisper offset calculation
│   └── transcribe_with_whisper.py    # Whisper transcription (called internally)
├── data/
│   ├── transcripts/                  # Raw ALL CAPS transcripts
│   ├── processed/                    # Capitalized transcripts
│   ├── whisper_cache/                # Cached Whisper transcriptions
│   ├── video_mapping_<id>.json       # YouTube video metadata + offsets
│   ├── standard_entities.json        # Entity database for capitalization
│   ├── hybrid_entity_database.json   # Combined entity names
│   ├── capitalization_config.json    # Case conversion rules
│   └── meetings_metadata.json        # Meeting schedule/type hints
└── venv/                             # Python virtual environment
```

### Whisper cache naming

Cache files encode the sample parameters:

- `<video_id>_base.json` — full video, base model
- `<video_id>_base_skip414s_300s.json` — skipped to 414s, captured 300s
- `<video_id>_small_10min.json` — 10-minute sample, small model

## Troubleshooting

### "No meaningful speech found in Whisper output"

The Whisper sample window likely landed on countdown music or silence. For Part 2+ videos this is handled automatically via chapter-based skip, but if chapters are missing, try re-running with `--no-cache` to force a fresh transcription.

### "Could not find Whisper text in official transcript"

- Verify you're using the **processed** (capitalized) transcript, not the raw ALL CAPS version
- Try `--model small` for better transcription quality at the cost of speed

### "No videos found for date"

- Meeting type may be wrong — try `--meeting-type CRA` or `--meeting-type "City Council"`
- Some dates have morning and evening sessions with different pkeys
- Older videos use abbreviated titles ("TCC"); the legacy fallback handles these

### Pipeline scripts

| Script                         | Purpose                                             |
| ------------------------------ | --------------------------------------------------- |
| `pipeline/process-meeting.sh`  | End-to-end: scrape → capitalize → video → DB → site |
| `pipeline/discover.py`         | Find unprocessed meetings, optionally auto-process  |
| `pipeline/activate.sh`         | Activate the shared Python venv                     |
| `pipeline/rebuild-entities.sh` | Rebuild entity databases from processed transcripts |

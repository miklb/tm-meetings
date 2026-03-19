# Transcript Processing Workflow

This document describes the complete workflow for processing Tampa City Council meeting transcripts and calculating YouTube video offsets.

## Overview

The workflow consists of 6 main steps:

1. **Scrape** - Download raw ALL CAPS transcript from tampagov.net
2. **Capitalize** - Convert ALL CAPS to proper sentence case
3. **Find Videos** - Locate YouTube videos for the meeting
4. **Transcribe Sample** - Use Whisper to transcribe first 10 minutes of video
5. **Calculate Offset** - Match Whisper output to official transcript
6. **Detect Gaps** - Find multi-part video boundaries (for multi-video meetings)

## Prerequisites

- Python 3.12+ with virtual environment activated
- YouTube Data API key configured in environment
- GLiNER model and entity databases set up
- OpenAI Whisper installed
- yt-dlp and FFmpeg available

## Environment Setup

**Activate the venv before running any command below.** All commands in this document assume the venv is active and working directory is `transcript-cleaner/processor/`.

```bash
# From project root
source pipeline/activate.sh
cd transcript-cleaner/processor

# Or directly
cd transcript-cleaner/processor
source venv/bin/activate
```

Verify: `python3 -c "import dotenv, gliner; print('ok')"`

## Step-by-Step Process

### 1. Scrape Transcript

Downloads the official transcript from tampagov.net in ALL CAPS format.

```bash
python src/scraper.py <meeting_id> <date>
```

**Example:**

```bash
python src/scraper.py 2645 2025-11-13
```

**Output:** `data/transcripts/transcript_2645_2025-11-13.json`

**Format:** ALL CAPS text with speaker names and timestamps

### 2. Capitalize Transcript

Converts ALL CAPS transcript to proper sentence case using entity databases and GLiNER NER model.

```bash
python src/capitalize_transcript.py data/transcripts/transcript_<id>_<date>.json data/processed/processed_transcript_<id>_<date>.json
```

**Example:**

```bash
python src/capitalize_transcript.py data/transcripts/transcript_2645_2025-11-13.json data/processed/processed_transcript_2645_2025-11-13.json
```

**Output:** `data/processed/processed_transcript_2645_2025-11-13.json`

**Format:** Proper sentence case with normalized speaker names

**Note:** This step takes 2-5 minutes as GLiNER loads and processes each segment.

### 3. Find YouTube Videos

Search YouTube for videos matching the meeting date and create video mapping.
Meeting type is auto-detected from the transcript when `--meeting-id` is provided.

```bash
python src/youtube_fetcher.py <date> --meeting-id <id>
```

**Example (auto-detected CRA meeting):**

```bash
# Meeting type auto-detected from transcript_2645_2025-11-13.json
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2645
```

**Example (explicit type override):**

```bash
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2645 --meeting-type CRA
```

**Example (explicit transcript path):**

```bash
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2645 \
  --transcript data/transcripts/transcript_2645_2025-11-13.json
```

**Output:** `data/video_mapping_2645.json`

**Format:**

```json
{
  "meeting_id": 2645,
  "meeting_date": "2025-11-13",
  "meeting_type": "CRA",
  "videos": [
    {
      "part": 1,
      "video_id": "SocxtU6vTKc",
      "title": "Community Redevelopment Agency - 11/13/25",
      "duration": "PT3H7M21S"
    }
  ]
}
```

**Notes:**

- Meeting type auto-detection checks: title field, opening segment text, scheduled time, and meetings_metadata.json
- For multi-part meetings (CRA AM sessions), all parts are found automatically
- Older videos using abbreviated titles ("TCC") are found via legacy fallback

### 4. Calculate Offset

Uses Whisper to transcribe the first 10 minutes of video and matches it to the official transcript to find the time offset. The calculated offset is **automatically saved** to the video mapping JSON.

```bash
python scripts/build/match_whisper_to_transcript.py <video_id> data/processed/processed_transcript_<id>_<date>.json --video-mapping data/video_mapping_<id>.json
```

**Example:**

```bash
python scripts/build/match_whisper_to_transcript.py SocxtU6vTKc data/processed/processed_transcript_2645_2025-11-13.json --video-mapping data/video_mapping_2645.json
```

**Output:**

- Console output showing match and calculated offset
- `offset_seconds` written directly to `data/video_mapping_2645.json` (for the matching video_id)
- Whisper output cached at `data/whisper_cache/<video_id>_small_10min.json`

**Options:**

- `--no-save` — Calculate offset without writing it to the video mapping file
- `--no-cache` — Force re-transcription even if cached Whisper output exists
- `--model <name>` — Whisper model: base, small (default), medium

**Whisper Cache:** `data/whisper_cache/<video_id>_small_10min.json`

### 5. Detect Transcript Gaps (Multi-Part Meetings)

For meetings with multiple video parts, detects time gaps in the official transcript (e.g., 90-minute lunch breaks) and writes `transcript_start_time` into the video mapping JSON. This tells `html_generator.py` which transcript segments belong to which video.

```bash
# Standalone
python -m src.transcript_gap_detector data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json

# Or integrated with offset calculation
python scripts/build/match_whisper_to_transcript.py SocxtU6vTKc \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json --detect-gaps
```

**Output:**

- Prints detected gaps with timestamps and duration
- Writes `transcript_start_time` to Part 2+ entries in the video mapping JSON

**Options:**

- `--min-gap <minutes>` — Minimum gap threshold (default: 60 minutes)
- `--dry-run` — Print gaps without saving to mapping file

### 6. Unified Pipeline (Recommended)

Instead of running steps 3-5 individually, use the unified pipeline command that chains them all together:

```bash
python scripts/build/process_video.py <meeting_id> <meeting_date>
```

**Example:**

```bash
# Full pipeline — auto-detects type, finds videos, calculates offsets, detects gaps
python scripts/build/process_video.py 2645 2025-11-13
```

The unified command:

- Locates the processed transcript (or raw fallback)
- Auto-detects meeting type
- Fetches YouTube videos (reuses existing mapping if present)
- Calculates adaptive Whisper sample duration per video part
- Transcribes and matches each part (skips already-done parts)
- Detects transcript gaps for multi-part meetings
- Prints a summary of all results

**Options:**

- `--meeting-type <type>` — Override auto-detected meeting type
- `--model <name>` — Whisper model: tiny, base, small (default), medium
- `--dry-run` — Show plan without making changes
- `--skip-fetch` — Use existing video mapping only (no YouTube API call)
- `--min-gap <minutes>` — Gap detection threshold (default: 60)

**Prerequisite:** Transcript must be scraped and capitalized first (steps 1-2).

## Directory Structure

```
data/
├── transcripts/              # Raw ALL CAPS transcripts from scraper
│   └── transcript_2645_2025-11-13.json
├── processed/                # Capitalized transcripts ready for matching
│   └── processed_transcript_2645_2025-11-13.json
├── video_mapping_2645.json   # YouTube video metadata
├── whisper_cache/            # Cached Whisper transcriptions
│   └── SocxtU6vTKc_small_10min.json
└── standard_entities.json    # Entity databases for capitalization
    hybrid_entity_database.json
```

## Common Scenarios

### Single Evening Meeting (City Council PM)

Using the unified pipeline:

```bash
# 1. Scrape
python src/scraper.py 2644 2025-11-13

# 2. Capitalize
python src/capitalize_transcript.py \
  data/transcripts/transcript_2644_2025-11-13.json \
  data/processed/processed_transcript_2644_2025-11-13.json

# 3. Run unified pipeline (steps 3-5 automated)
python scripts/build/process_video.py 2644 2025-11-13
```

<details>
<summary>Manual step-by-step (equivalent)</summary>

```bash
# 3. Find video (type auto-detected from transcript)
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2644

# 4. Calculate offset (auto-saved to video mapping)
python scripts/build/match_whisper_to_transcript.py \
  Y4gKHr6J5mU \
  data/processed/processed_transcript_2644_2025-11-13.json \
  --video-mapping data/video_mapping_2644.json
```

</details>

### Multi-Part AM Meeting (CRA)

Using the unified pipeline:

```bash
# 1. Scrape
python src/scraper.py 2645 2025-11-13

# 2. Capitalize
python src/capitalize_transcript.py \
  data/transcripts/transcript_2645_2025-11-13.json \
  data/processed/processed_transcript_2645_2025-11-13.json

# 3. Run unified pipeline (handles all parts, gaps, etc.)
python scripts/build/process_video.py 2645 2025-11-13
```

<details>
<summary>Manual step-by-step (equivalent)</summary>

```bash
# 3. Find videos (type auto-detected as CRA from transcript text)
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2645

# 4. Calculate offset for Part 1 (auto-saved)
python scripts/build/match_whisper_to_transcript.py \
  SocxtU6vTKc \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json

# 5. Calculate offset for Part 2 (auto-saved)
python scripts/build/match_whisper_to_transcript.py \
  oCSGYDZXHbk \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json

# 6. Detect transcript gaps → sets transcript_start_time for Part 2
python -m src.transcript_gap_detector \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json
```

</details>

### Testing: Meeting 2656 (February 5, 2026)

Complete walkthrough for processing the City Council meeting on February 5, 2026 (pkey 2656).

**Prerequisites:**

- Virtual environment activated: `source venv/bin/activate`
- `YOUTUBE_API_KEY` environment variable set
- Working directory: `transcript-cleaner/processor/`

```bash
# Step 1: Scrape transcript from tampagov.net
python src/scraper.py 2656 2026-02-05

# Step 2: Capitalize transcript (2-5 min, loads GLiNER model)
python src/capitalize_transcript.py \
  data/transcripts/transcript_2656_2026-02-05.json \
  data/processed/processed_transcript_2656_2026-02-05.json

# Step 3: Run unified video pipeline (fetches videos, calculates offsets, detects gaps)
python scripts/build/process_video.py 2656 2026-02-05
```

**What to expect:**

1. The scraper downloads the ALL CAPS transcript from `https://apps.tampagov.net/cttv_cc_webapp/Agenda.aspx?pkey=2656`
2. The capitalizer converts to sentence case (~600+ segments, takes 2-5 min)
3. The pipeline:
   - Auto-detects meeting type from transcript (likely "City Council" for a Thursday)
   - Searches YouTube for matching videos
   - For each video part:
     - Calculates adaptive sample duration (600s for Part 1, up to 900s+ for Part 2+)
     - Downloads and transcribes audio with Whisper (~2-5 min per part)
     - Matches Whisper output to official transcript to find time offset
     - Saves `offset_seconds` to `data/video_mapping_2656.json`
   - If multi-part, detects lunch-break gaps and saves `transcript_start_time`
   - Prints a summary

**Dry-run first (recommended):** To preview without making API calls or downloading audio:

```bash
# After steps 1-2, preview what the pipeline would do
python scripts/build/process_video.py 2656 2026-02-05 --dry-run
```

**Verify results:**

```bash
# Check the video mapping
cat data/video_mapping_2656.json | python -m json.tool

# Verify offsets are populated
python -c "
import json
with open('data/video_mapping_2656.json') as f:
    m = json.load(f)
for v in m['videos']:
    offset = v.get('offset_seconds', 'MISSING')
    tst = v.get('transcript_start_time', '')
    print(f\"Part {v['part']}: {v['video_id']}  offset={offset}  {tst}\")
"
```

**If something goes wrong:**

- **No videos found:** The meeting recording may not be uploaded yet. Try again in a few days, or use `--meeting-type "City Council"` to override auto-detection.
- **Whisper match fails:** Try `--model medium` for better accuracy, or check that the capitalized transcript was generated correctly.
- **Rate limited:** Wait a few minutes and retry. The pipeline automatically caches Whisper transcriptions and skips already-calculated offsets.

## Troubleshooting

### "No meaningful speech found in Whisper output"

- Video may have a long intro (8+ minutes of silence/music)
- Solution: Stick with default 10-minute sample; offset detection will still work if speech appears within that window
- For Part 2+ videos with long intros, try `--duration 900` (15 minutes)

### "Text too different from transcript"

- Verify you're using the **processed** transcript, not the raw one
- Raw transcripts are ALL CAPS and won't match Whisper's mixed-case output
- Check that `src/capitalize_transcript.py` ran successfully

### "No videos found for date"

- Meeting type may be wrong — check auto-detected type vs actual video title
- Try `--meeting-type CRA` or `--meeting-type "City Council"` explicitly
- Verify date format is YYYY-MM-DD
- Some dates may have morning and evening sessions
- Older videos use abbreviated titles ("TCC"); the legacy fallback should catch these

### GLiNER loading is slow

- First run downloads the model (~100MB)
- Subsequent runs load from cache (~30 seconds)
- Processing 600+ segments takes 2-5 minutes

## Notes

- **Meeting type detection:** Auto-detected from transcript title, segment text, and scheduled time. Override with `--meeting-type`.
- **Offset auto-save:** Calculated offsets are written directly to the video mapping JSON. Disable with `--no-save`.
- **Default Whisper duration:** 10 minutes (600 seconds)
- **Whisper model:** `small` (best balance of speed/accuracy)
- **Cache:** Whisper outputs are cached in `data/whisper_cache/` to avoid re-transcription
- **Video mapping:** Recommended — provides smart duration hints and enables auto-save of offsets
- **Gap detection:** Run on multi-part meetings after calculating offsets to populate `transcript_start_time`. Without it, Part 2+ video timestamps will be incorrect.
- **Legacy videos:** Older videos (pre-2025) use "TCC" abbreviations instead of full meeting type names; auto-retried via legacy fallback

## Files Referenced

- `src/scraper.py` - Scrapes transcripts from tampagov.net
- `src/capitalize_transcript.py` - Converts ALL CAPS to sentence case
- `src/meeting_type_detector.py` - Auto-detects meeting type from transcript data
- `src/youtube_fetcher.py` - Finds YouTube videos by date (with auto-detection)
- `src/transcript_gap_detector.py` - Detects multi-part boundaries from timestamp gaps
- `scripts/build/process_video.py` - Unified pipeline: chains steps 3-5 into one command
- `scripts/build/match_whisper_to_transcript.py` - Calculates offset via Whisper (with auto-save)
- `scripts/build/transcribe_with_whisper.py` - Called internally by match script
- `src/html_generator.py` - Generates static HTML with video-synced timestamps
- `docs/VIDEO_PIPELINE.md` - Full pipeline plan (all steps complete)

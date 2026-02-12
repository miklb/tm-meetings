# Video Pipeline Plan

Phased plan to consolidate the video matching and offset calculation into a single automated pipeline.

**Status:** All steps complete (1-5).

---

## Completed

### Step 1: Meeting Type Auto-Detection

**File:** `src/meeting_type_detector.py`

Automatically detects meeting type from transcript data so youtube_fetcher.py no longer requires manual `--meeting-type` specification.

**Detection priority:**

1. `meeting_title` field — specific types (CRA, Workshop, Special, Evening) match first
2. First 5 segment texts — catches CRA meetings with generic title
3. `meeting_date_time` field — evening meetings detected by 5:01 P.M. scheduled time
4. `meetings_metadata.json` lookup — fallback for older meetings
5. Default: "City Council"

**Integration points:**

- `youtube_fetcher.py` — `save_video_mapping()` auto-detects when `--meeting-type` is omitted
- `youtube_fetcher.py` CLI — `--transcript` flag for explicit transcript path
- Legacy fallback — older videos using "TCC" abbreviations are retried automatically

**Usage (no change needed for explicit type):**

```bash
# Before: required --meeting-type
python src/youtube_fetcher.py 2025-11-13 --meeting-type CRA

# After: auto-detected from transcript
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2645

# Or with explicit transcript path
python src/youtube_fetcher.py 2025-11-13 --meeting-id 2645 --transcript data/transcripts/transcript_2645_2025-11-13.json
```

### Step 2: Offset Auto-Save

**File:** `scripts/build/match_whisper_to_transcript.py`

After calculating the offset, the script now writes `offset_seconds` directly back into the video mapping JSON file. No more manual JSON editing.

**Behavior:**

- Enabled by default when `--video-mapping` is provided
- Finds the matching `video_id` entry and sets `offset_seconds`
- Disable with `--no-save` flag if you want dry-run behavior
- Prints confirmation: `✅ Saved offset_seconds=552 to video_mapping_2645.json for video SocxtU6vTKc`

**Usage (unchanged, just works now):**

```bash
python scripts/build/match_whisper_to_transcript.py SocxtU6vTKc \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json
# → Calculates offset AND saves it to the file
```

### Step 3: Transcript Gap Detection

**File:** `src/transcript_gap_detector.py`

Scans consecutive segment timestamps in the official transcript to find time gaps > 60 minutes (lunch breaks, streaming interruptions). Populates `transcript_start_time` in the video mapping JSON, which `html_generator.py` uses to assign segments to the correct video part.

**How it works:**

1. Parse each segment's wall-clock timestamp (e.g., `12:02:47PM`) to minutes since midnight
2. Compare consecutive timestamps — gaps > threshold are video part boundaries
3. Map gaps sequentially to Part 2, Part 3, etc.
4. Write `transcript_start_time` (the resume timestamp) into the video mapping

**Verified on real data:** Meeting 2645 correctly detects a 93.8-minute lunch break (12:02:47PM → 1:36:37PM).

**Standalone usage:**

```bash
# Detect gaps and display
python -m src.transcript_gap_detector data/processed/processed_transcript_2645_2025-11-13.json

# Detect gaps and save to video mapping
python -m src.transcript_gap_detector data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json

# Dry run (detect only, don't save)
python -m src.transcript_gap_detector data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json --dry-run

# Custom threshold (default: 60 minutes)
python -m src.transcript_gap_detector transcript.json --min-gap 45
```

**Integrated usage (via match_whisper_to_transcript.py):**

```bash
python scripts/build/match_whisper_to_transcript.py SocxtU6vTKc \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json \
  --detect-gaps
# → Calculates offset, saves it, THEN detects gaps and saves transcript_start_time
```

---

### Step 4: Adaptive Whisper Duration

**File:** `scripts/build/match_whisper_to_transcript.py` — `calculate_smart_duration()`

Dynamically determines the optimal Whisper audio sample length based on part number, chapter data, and meeting start time. Replaces the previous stub that always returned 600s.

**Rules applied:**
| Scenario | Duration | Rationale |
|----------|----------|-----------|
| Part 1, no chapters | 600s (10 min) | Standard |
| Part 1, chapters available | 600s | First chapter is usually at 0:00 |
| Part 2+, chapters show content > 600s | `chapter[1].seconds + 120` | Sample past the intro |
| Part 2+, chapters ≤ 600s | 600s | Fits within default |
| Part 2+, no chapter data | 900s (15 min) | Conservative default |
| Part 2+, only "Start" chapter (len=1) | 900s | Treated as no usable chapter data |
| Evening session (transcript starts ≥ 5 PM) | +120s buffer | Evening intros tend to be longer |

**Meeting start time evaluation:**

The function reads the first segment timestamp from the official transcript to detect evening sessions (≥ 5 PM), which get an additional 120-second buffer on any part. Afternoon meetings (< 5 PM) do not receive the buffer. This handles the pattern where evening sessions have longer countdown graphics before the meeting begins.

**Verified on real data:**

- Meeting 2645 Part 2: chapter at 672s → 792s sample (covers actual 630s intro)
- Meeting 2637 Part 2: chapter at 506s → 600s (fits within default, covers actual 476s intro)

### Step 5: Unified `process_video.py` Command

**File:** `scripts/build/process_video.py`

Single entry point that chains Steps 1-4 into one command per meeting. Handles transcript discovery, meeting type auto-detection, YouTube video fetching, adaptive Whisper transcription, offset matching, and gap detection.

**Usage:**

```bash
# Full pipeline for one meeting
python scripts/build/process_video.py 2645 2025-11-13

# With explicit type override
python scripts/build/process_video.py 2645 2025-11-13 --meeting-type CRA

# Dry run (show what would happen)
python scripts/build/process_video.py 2645 2025-11-13 --dry-run

# Skip YouTube API call (use existing video mapping only)
python scripts/build/process_video.py 2645 2025-11-13 --skip-fetch
```

**Flow:**

1. Locate transcript (processed → raw fallback) and auto-detect meeting type
2. Call YouTube Data API to find videos → save `video_mapping_<ID>.json` (or reuse existing)
3. For each video part:
   a. Calculate Whisper sample duration (adaptive — Step 4)
   b. Transcribe with Whisper (cached in `data/whisper_cache/`)
   c. Match to official transcript → auto-save `offset_seconds`
4. Detect transcript gaps → save `transcript_start_time` for Part 2+ (multi-part only)
5. Print summary with final state of all video entries

**Smart behaviors:**

- Skips videos that already have `offset_seconds` set
- Reuses existing video mapping files (won't re-fetch from YouTube API)
- Uses Whisper cache from previous runs
- Rate-limits yt-dlp downloads (7s delay between consecutive videos)
- Detects evening sessions from transcript start time for longer Whisper samples

**Rate limiting considerations:**

- YouTube Data API: ~102 quota units per meeting (search + video details). Safe for ~90 meetings/day on free tier.
- yt-dlp audio download: 7-second delay between consecutive video downloads to avoid throttling.
- Whisper: Local CPU only, no rate limits. `small` model balances speed/accuracy.
- No `youtube-transcript-api` calls — avoids IP banning entirely.

**Prerequisite:** Transcript must already be scraped and capitalized (WORKFLOW.md steps 1-2).

---

## Data Schema

### video*mapping*<ID>.json (current + planned fields)

```json
{
  "meeting_id": 2645,
  "meeting_date": "2025-11-13",
  "meeting_type": "CRA",
  "videos": [
    {
      "video_id": "SocxtU6vTKc",
      "title": "Community Redevelopment Agency - 11/13/25",
      "part": 1,
      "session": null,
      "published_at": "2025-11-14T05:21:32Z",
      "duration": "PT3H7M21S",
      "offset_seconds": 552,
      "transcript_start_time": null,
      "chapters": [...]
    },
    {
      "video_id": "oCSGYDZXHbk",
      "title": "Community Redevelopment Agency - 11/13/25 - Part 2",
      "part": 2,
      "session": null,
      "published_at": "2025-11-14T09:35:21Z",
      "duration": "PT2H55M48S",
      "offset_seconds": 630,
      "transcript_start_time": "1:36:00PM",
      "chapters": [...]
    }
  ]
}
```

- `offset_seconds` — seconds of dead time (intro/music) before speech starts **in that video**
- `transcript_start_time` — the official transcript timestamp where this video's content begins (Step 3)
- `meeting_type` — canonical label, added by Step 1

---

## File Inventory

| File                                           | Status       | Purpose                                              |
| ---------------------------------------------- | ------------ | ---------------------------------------------------- |
| `src/meeting_type_detector.py`                 | ✅ Done      | Meeting type auto-detection                          |
| `src/youtube_fetcher.py`                       | ✅ Updated   | Integrated auto-detection + legacy fallback          |
| `scripts/build/match_whisper_to_transcript.py` | ✅ Updated   | Auto-save offset + gap detection + adaptive duration |
| `tests/test_meeting_type_detector.py`          | ✅ Done      | Tests for detection + offset save                    |
| `tests/test_smart_duration.py`                 | ✅ Done      | Tests for adaptive Whisper duration                  |
| `src/transcript_gap_detector.py`               | ✅ Done      | Transcript gap detection                             |
| `tests/test_transcript_gap_detector.py`        | ✅ Done      | Tests for gap detection + mapping save               |
| `scripts/build/process_video.py`               | ✅ Done      | Unified video pipeline command                       |
| `tests/test_process_video.py`                  | ✅ Done      | Tests for unified pipeline                           |
| `docs/VIDEO_PIPELINE.md`                       | ✅ This file | Plan and reference                                   |

---

_Last updated: February 11, 2026_

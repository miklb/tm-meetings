# Transcript Processor

Processes Tampa City Council meeting transcripts from ALL CAPS to readable sentence case with named entity recognition and YouTube video synchronization.

Part of the [Tampa Meetings](https://github.com/miklb/tampa-meetings) project.

---

## What It Does

1. **Scrapes** official transcripts from tampagov.net (ALL CAPS format)
2. **Capitalizes** text using entity databases + GLiNER zero-shot NER
3. **Finds** matching YouTube videos for the meeting
4. **Calculates** video-to-transcript time offsets via Whisper
5. **Generates** static HTML pages with clickable video timestamps

## Prerequisites

- Python 3.12+
- YouTube Data API key (see [docs/YOUTUBE_SETUP.md](docs/YOUTUBE_SETUP.md))
- FFmpeg (for audio extraction)
- OpenAI Whisper (for offset calculation)

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and add your YouTube API key.

## Quick Start

See [WORKFLOW.md](WORKFLOW.md) for the complete step-by-step guide.

```bash
# 1. Scrape transcript
python src/scraper.py 2645 2025-11-13

# 2. Capitalize
python src/capitalize_transcript.py \
  data/transcripts/transcript_2645_2025-11-13.json \
  data/processed/processed_transcript_2645_2025-11-13.json

# 3. Find YouTube videos
python src/youtube_fetcher.py 2025-11-13 --meeting-type CRA

# 4. Calculate video offset
python scripts/build/match_whisper_to_transcript.py \
  SocxtU6vTKc \
  data/processed/processed_transcript_2645_2025-11-13.json \
  --video-mapping data/video_mapping_2645.json

# 5. Generate HTML
python src/html_generator.py
```

## Project Structure

```
processor/
├── src/                          # Source code
│   ├── scraper.py                # Scrapes transcripts from tampagov.net
│   ├── capitalize_transcript.py  # ALL CAPS → sentence case (GLiNER + entity DB)
│   ├── meeting_type_detector.py  # Auto-detects meeting type (CRA/Workshop/etc.)
│   ├── youtube_fetcher.py        # Finds YouTube videos by date
│   └── html_generator.py        # Static HTML generation with video sync
│
├── scripts/
│   ├── build/                    # Build pipeline scripts
│   │   ├── match_whisper_to_transcript.py
│   │   ├── transcribe_with_whisper.py
│   │   ├── calculate_offset_whisper.py
│   │   ├── combine_entity_sources.py
│   │   └── extract_agenda_entities.py
│   ├── entity_sources/           # Entity database download scripts
│   └── tests/                    # Test scripts
│
├── data/
│   ├── transcripts/              # Raw ALL CAPS transcripts
│   ├── processed/                # Capitalized transcripts
│   ├── agendas/                  # Agenda JSON (for entity extraction)
│   ├── sources/                  # Entity source data (holidays, states, etc.)
│   ├── whisper_cache/            # Cached Whisper transcriptions
│   ├── standard_entities.json    # Standard entity database
│   ├── hybrid_entity_database.json  # Combined entity database
│   ├── video_mapping_*.json      # Per-meeting video metadata
│   └── meetings_metadata.json    # Meeting metadata cache
│
├── templates/                    # Jinja2 HTML templates
│   ├── base.html
│   ├── index.html
│   └── transcript.html
│
├── output/site/                  # Generated static HTML
│
├── docs/                         # Documentation
│   ├── CAPITALIZATION_SOURCES.md
│   ├── OFFSET_DETECTION_IMPROVEMENTS.md
│   ├── YOUTUBE_SETUP.md
│   ├── MULTI_PART_VIDEOS.md
│   ├── WORKFLOW_IMPROVEMENTS.md
│   └── AGENDA_SCHEMA.md
│
├── WORKFLOW.md                   # Step-by-step processing guide
├── requirements.txt
└── .gitignore
```

## Data Coverage

| Type                       | Count | Date Range          |
| -------------------------- | ----- | ------------------- |
| Raw transcripts            | 14    | Nov 2022 – Dec 2025 |
| Processed transcripts      | 11    | Nov 2022 – Dec 2025 |
| HTML pages generated       | 10    | Nov 2022 – Nov 2025 |
| Agenda JSON (for entities) | 27    | Jul – Nov 2025      |

## Known Issues

- GLiNER model load takes ~30 seconds on first run
- `youtube-transcript-api` is deprecated; offset calculation uses Whisper instead
- Some video intros are 8+ minutes of silence, complicating offset detection (see [docs/VIDEO_PIPELINE.md](docs/VIDEO_PIPELINE.md) Step 4)
- Part 2+ transcript boundaries (`transcript_start_time`) not yet auto-populated (see [docs/VIDEO_PIPELINE.md](docs/VIDEO_PIPELINE.md) Step 3)

## Utility Scripts

- `reprocess_all_transcripts.py` — Re-run capitalizer on all raw transcripts
- `generate_metadata.py` — Generate metadata summary from agenda JSON files

---

_A [Tampa Monitor](https://tampamonitor.com) project_

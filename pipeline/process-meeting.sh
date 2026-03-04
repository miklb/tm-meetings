#!/usr/bin/env bash
#
# process-meeting.sh — End-to-end pipeline for a single Tampa City Council
# meeting transcript: scrape → capitalize → video → rebuild DB → rebuild site.
#
# Usage:
#   ./pipeline/process-meeting.sh <transcript_pkey> <date> [options]
#
# Examples:
#   # Process a known transcript
#   ./pipeline/process-meeting.sh 2645 2025-11-13
#
#   # Skip video processing (no YouTube key, or no video yet)
#   ./pipeline/process-meeting.sh 2645 2025-11-13 --skip-video
#
#   # Override meeting type detection
#   ./pipeline/process-meeting.sh 2645 2025-11-13 --meeting-type CRA
#
#   # Skip the site rebuild step
#   ./pipeline/process-meeting.sh 2645 2025-11-13 --skip-site
#
#   # Dry run — show what would be done without executing
#   ./pipeline/process-meeting.sh 2645 2025-11-13 --dry-run
#
# Prerequisites:
#   - Python venv at transcript-cleaner/processor/venv/ with deps installed
#   - Node.js with better-sqlite3 available
#   - YOUTUBE_API_KEY env var set (for video step)
#   - Entity databases built (run pipeline/rebuild-entities.sh if needed)

set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROCESSOR_DIR="$PROJECT_ROOT/transcript-cleaner/processor"
VENV_PYTHON="$PROCESSOR_DIR/venv/bin/python"
SITE_DIR="$PROJECT_ROOT/site"

# Transcript data directories (relative to PROCESSOR_DIR)
RAW_DIR="$PROCESSOR_DIR/data/transcripts"
PROCESSED_DIR="$PROCESSOR_DIR/data/processed"

# ── Defaults ───────────────────────────────────────────────────────────────────
SKIP_VIDEO=false
SKIP_SITE=false
DRY_RUN=false
MEETING_TYPE=""

# ── Parse args ─────────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <transcript_pkey> <date> [options]"
    echo ""
    echo "Options:"
    echo "  --skip-video       Skip YouTube video matching / Whisper offset"
    echo "  --skip-site        Skip DB rebuild and Eleventy build"
    echo "  --meeting-type T   Override meeting type (CRA, workshop, evening, regular)"
    echo "  --dry-run          Show what would be done without executing"
    exit 1
fi

PKEY="$1"
DATE="$2"
shift 2

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-video)  SKIP_VIDEO=true; shift ;;
        --skip-site)   SKIP_SITE=true; shift ;;
        --dry-run)     DRY_RUN=true; shift ;;
        --meeting-type) MEETING_TYPE="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# ── Validation ─────────────────────────────────────────────────────────────────
if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: Python venv not found at $VENV_PYTHON"
    echo "Set up with: cd $PROCESSOR_DIR && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
    exit 1
fi

if ! command -v node &>/dev/null; then
    echo "ERROR: node not found. Install Node.js first."
    exit 1
fi

# ── File paths ─────────────────────────────────────────────────────────────────
RAW_FILE="$RAW_DIR/transcript_${PKEY}_${DATE}.json"
PROCESSED_FILE="$PROCESSED_DIR/processed_transcript_${PKEY}_${DATE}.json"

# ── Helpers ────────────────────────────────────────────────────────────────────
step() {
    local num="$1"; shift
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Step $num: $*"
    echo "════════════════════════════════════════════════════════════"
}

run() {
    if $DRY_RUN; then
        echo "[dry-run] $*"
    else
        "$@"
    fi
}

elapsed() {
    local start="$1"
    local end
    end=$(date +%s)
    echo "$(( end - start ))s"
}

# ══════════════════════════════════════════════════════════════════════════════
#  Pipeline
# ══════════════════════════════════════════════════════════════════════════════
PIPELINE_START=$(date +%s)
echo "Pipeline: transcript $PKEY ($DATE)"
echo "  Project root:  $PROJECT_ROOT"
echo "  Processor dir: $PROCESSOR_DIR"
echo "  Skip video:    $SKIP_VIDEO"
echo "  Skip site:     $SKIP_SITE"
echo "  Dry run:       $DRY_RUN"
[[ -n "$MEETING_TYPE" ]] && echo "  Meeting type:  $MEETING_TYPE" || true

# ── Step 1: Scrape transcript ──────────────────────────────────────────────────
step 1 "Scrape transcript (pkey=$PKEY)"

if [[ -f "$RAW_FILE" ]]; then
    echo "Already exists: $RAW_FILE — skipping scrape."
else
    STEP_START=$(date +%s)
    (
        cd "$PROCESSOR_DIR"
        run "$VENV_PYTHON" src/scraper.py "$PKEY" "$DATE"
    )
    echo "Done ($(elapsed "$STEP_START"))"
fi

# Verify raw file exists
if ! $DRY_RUN && [[ ! -f "$RAW_FILE" ]]; then
    echo "ERROR: Expected raw transcript not found: $RAW_FILE"
    exit 1
fi

# ── Step 2: Capitalize transcript ──────────────────────────────────────────────
step 2 "Capitalize transcript"

if [[ -f "$PROCESSED_FILE" ]]; then
    echo "Already exists: $PROCESSED_FILE — skipping capitalize."
else
    STEP_START=$(date +%s)
    echo "This typically takes 2-5 minutes (GLiNER model loading)..."
    (
        cd "$PROCESSOR_DIR"
        run "$VENV_PYTHON" src/capitalize_transcript.py "$RAW_FILE" "$PROCESSED_FILE"
    )
    echo "Done ($(elapsed "$STEP_START"))"
fi

# Verify processed file exists
if ! $DRY_RUN && [[ ! -f "$PROCESSED_FILE" ]]; then
    echo "ERROR: Expected processed transcript not found: $PROCESSED_FILE"
    exit 1
fi

# ── Step 3: Video pipeline (YouTube + Whisper + gap detection) ─────────────────
if $SKIP_VIDEO; then
    step 3 "Video pipeline — SKIPPED (--skip-video)"
else
    step 3 "Video pipeline (YouTube search → Whisper offset → gap detection)"

    if [[ -z "${YOUTUBE_API_KEY:-}" ]]; then
        echo "WARNING: YOUTUBE_API_KEY not set. Video step will likely fail."
        echo "Set it with: export YOUTUBE_API_KEY=your-key"
        echo "Or pass --skip-video to skip this step."
    fi

    VIDEO_ARGS=("$PKEY" "$DATE")
    if [[ -n "$MEETING_TYPE" ]]; then
        VIDEO_ARGS+=("--meeting-type" "$MEETING_TYPE")
    fi

    STEP_START=$(date +%s)
    (
        cd "$PROCESSOR_DIR"
        run "$VENV_PYTHON" scripts/build/process_video.py "${VIDEO_ARGS[@]}"
    )
    echo "Done ($(elapsed "$STEP_START"))"
fi

# ── Step 4: Rebuild database ──────────────────────────────────────────────────
if $SKIP_SITE; then
    step 4 "Rebuild database — SKIPPED (--skip-site)"
else
    step 4 "Rebuild SQLite database"

    STEP_START=$(date +%s)
    (
        cd "$PROJECT_ROOT"
        run node scripts/build-db.js
    )
    echo "Done ($(elapsed "$STEP_START"))"
fi

# ── Step 5: Rebuild site ─────────────────────────────────────────────────────
if $SKIP_SITE; then
    step 5 "Rebuild site — SKIPPED (--skip-site)"
else
    step 5 "Rebuild Eleventy site"

    STEP_START=$(date +%s)
    (
        cd "$SITE_DIR"
        run npx @11ty/eleventy
    )
    echo "Done ($(elapsed "$STEP_START"))"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Pipeline complete ($(elapsed "$PIPELINE_START") total)"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  Raw transcript:       $RAW_FILE"
echo "  Processed transcript: $PROCESSED_FILE"
if ! $SKIP_VIDEO; then
    VM="$PROCESSOR_DIR/data/video_mapping_${PKEY}.json"
    if [[ -f "$VM" ]]; then
        echo "  Video mapping:        $VM"
    fi
fi
if ! $SKIP_SITE; then
    echo "  Database:             $PROJECT_ROOT/data/meetings.db"
    echo "  Site output:          $SITE_DIR/_site/"
fi

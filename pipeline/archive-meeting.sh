#!/usr/bin/env bash
#
# archive-meeting.sh — End-to-end pipeline for a single Tampa City Council
# meeting transcript: scrape → capitalize → video → rebuild DB → rebuild site.
#
# Usage:
#   npm run archive -- <date> [options]           (from project root)
#   ./pipeline/archive-meeting.sh <date> [options]
#   ./pipeline/archive-meeting.sh <transcript_pkey> <date> [options]
#
# Examples:
#   # Process by date (auto-discovers pkey from tampagov)
#   npm run archive -- 2025-11-13
#
#   # Process a known transcript pkey
#   ./pipeline/archive-meeting.sh 2645 2025-11-13
#
#   # Skip video processing (no YouTube key, or no video yet)
#   npm run archive -- 2025-11-13 --skip-video
#
#   # Override meeting type detection
#   npm run archive -- 2025-11-13 --meeting-type CRA
#
#   # Skip the site rebuild step
#   npm run archive -- 2025-11-13 --skip-site
#
#   # Skip the post-meeting agenda re-check (Step 0: re-scrape → mirror →
#   # reconcile → markdown, then report late-added / unmirrored documents)
#   npm run archive -- 2025-11-13 --skip-agenda
#
#   # Dry run — show what would be done without executing
#   npm run archive -- 2025-11-13 --dry-run
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
SKIP_VERIFY=false
SKIP_AGENDA=false
DRY_RUN=false
MEETING_TYPE=""
LOOKUP_PAGES=1

# ── Parse args ─────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <date> [options]"
    echo "       $0 <transcript_pkey> <date> [options]"
    echo ""
    echo "Options:"
    echo "  --skip-video       Skip YouTube video matching / Whisper offset"
    echo "  --skip-verify      Skip the empirical offset verification gate (Step 3b)"
    echo "  --skip-site        Skip DB rebuild and Eleventy build"
    echo "  --skip-agenda      Skip the post-meeting agenda re-check (late docs / mirror audit)"
    echo "  --meeting-type T   Override meeting type (CRA, workshop, evening, regular)"
    echo "  --pages N          Transcript index pages to search for the date (default: 1;"
    echo "                     use more for older meetings, e.g. 8 reaches back ~1 year)"
    echo "  --dry-run          Show what would be done without executing"
    exit 1
fi

# Detect whether first arg is a date (YYYY-MM-DD) or a numeric pkey
if [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    # Date-only mode — look up the pkey automatically
    DATE="$1"
    PKEY=""
    shift
else
    # Legacy mode — explicit pkey + date
    PKEY="$1"
    if [[ $# -lt 2 ]]; then
        echo "ERROR: When passing a pkey, you must also specify a date."
        echo "Usage: $0 <date> [options]"
        exit 1
    fi
    DATE="$2"
    shift 2
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-video)  SKIP_VIDEO=true; shift ;;
        --skip-verify) SKIP_VERIFY=true; shift ;;
        --skip-site)   SKIP_SITE=true; shift ;;
        --skip-agenda) SKIP_AGENDA=true; shift ;;
        --dry-run)     DRY_RUN=true; shift ;;
        --meeting-type) MEETING_TYPE="$2"; shift 2 ;;
        --pages)       LOOKUP_PAGES="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

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

# ── Resolve pkey from date if needed ───────────────────────────────────────────
# ── Step 0: Agenda final check (date mode only — runs once per date) ──────────
# Catches documents the clerk attached after the last weekday agenda run, so
# the DB/site rebuild below and the tm-static post reflect the final agenda.
# Legacy pkey+date invocations (including the per-pkey recursion for
# multi-transcript dates) skip this so it never runs twice.
if [[ -z "$PKEY" ]]; then
    if $SKIP_AGENDA; then
        step 0 "Agenda final check — SKIPPED (--skip-agenda)"
    else
        step 0 "Agenda final check (re-scrape → mirror → reconcile → markdown)"
        STEP_START=$(date +%s)
        AGENDA_ARGS=("$DATE")
        $DRY_RUN && AGENDA_ARGS+=("--dry-run")
        if ! bash "$PROJECT_ROOT/pipeline/agenda-final-check.sh" "${AGENDA_ARGS[@]}"; then
            echo "WARNING: agenda final check failed — continuing with transcript archive."
            echo "         Re-run by hand: ./pipeline/agenda-final-check.sh $DATE"
        fi
        echo "Done ($(elapsed "$STEP_START"))"
    fi
fi

if [[ -z "$PKEY" ]]; then
    echo "Looking up transcript pkey for $DATE..."
    PKEYS=$("$VENV_PYTHON" "$PROJECT_ROOT/pipeline/transcript_lookup.py" --date "$DATE" --pkey-only --pages "$LOOKUP_PAGES" 2>/dev/null)
    PKEY_COUNT=$(echo "$PKEYS" | grep -c . || true)

    if [[ "$PKEY_COUNT" -eq 0 ]] || [[ -z "$PKEYS" ]]; then
        echo "ERROR: No transcript found for date $DATE on tampagov.net."
        echo "Try: python3 pipeline/transcript_lookup.py --date $DATE"
        exit 1
    elif [[ "$PKEY_COUNT" -eq 1 ]]; then
        PKEY="$PKEYS"
        echo "  Found pkey: $PKEY"
    else
        echo "Multiple transcripts found for $DATE — processing all $PKEY_COUNT"
        "$VENV_PYTHON" "$PROJECT_ROOT/pipeline/transcript_lookup.py" --date "$DATE" 2>/dev/null
        echo ""

        # Process each pkey with --skip-site, then do one rebuild at the end
        MULTI_FAILURES=0
        while IFS= read -r MULTI_PKEY; do
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "  Processing pkey $MULTI_PKEY ($DATE)"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            MULTI_ARGS=("$MULTI_PKEY" "$DATE" "--skip-site")
            $SKIP_VIDEO && MULTI_ARGS+=("--skip-video")
            $SKIP_VERIFY && MULTI_ARGS+=("--skip-verify")
            [[ -n "$MEETING_TYPE" ]] && MULTI_ARGS+=("--meeting-type" "$MEETING_TYPE")
            $DRY_RUN && MULTI_ARGS+=("--dry-run")

            if ! bash "$0" "${MULTI_ARGS[@]}"; then
                echo "FAILED: pkey=$MULTI_PKEY"
                (( MULTI_FAILURES++ )) || true
            fi
        done <<< "$PKEYS"

        # Single site rebuild at the end (unless --skip-site)
        if ! $SKIP_SITE; then
            step 4 "Rebuild SQLite database (combined)"
            ( cd "$PROJECT_ROOT" && run node scripts/build-db.js )
            step 5 "Rebuild Eleventy site (combined)"
            ( cd "$SITE_DIR" && run npx @11ty/eleventy )
        fi

        if [[ "$MULTI_FAILURES" -gt 0 ]]; then
            echo "WARNING: $MULTI_FAILURES meeting(s) failed."
            exit 1
        fi
        exit 0
    fi
fi

# ── File paths ─────────────────────────────────────────────────────────────────
RAW_FILE="$RAW_DIR/transcript_${PKEY}_${DATE}.json"
PROCESSED_FILE="$PROCESSED_DIR/processed_transcript_${PKEY}_${DATE}.json"

# ══════════════════════════════════════════════════════════════════════════════
#  Pipeline
# ══════════════════════════════════════════════════════════════════════════════
PIPELINE_START=$(date +%s)
echo "Pipeline: transcript $PKEY ($DATE)"
echo "  Project root:  $PROJECT_ROOT"
echo "  Processor dir: $PROCESSOR_DIR"
echo "  Skip video:    $SKIP_VIDEO"
echo "  Skip site:     $SKIP_SITE"
echo "  Skip agenda:   $SKIP_AGENDA"
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

# ── Step 3b: Verify offsets (structural audit + empirical audio check) ────────
# The Whisper matcher can lock onto the wrong phrase and save a confidently
# wrong offset (2026-08-26: seven archived meetings were off by 2–140 min).
# Check its output before it reaches the DB: audit-video-offsets.py catches
# overshoot / missing part boundaries; verify-offset.py transcribes a
# mid-meeting window and measures actual drift for every video part.
if $SKIP_VIDEO || $SKIP_VERIFY; then
    step 3b "Verify offsets — SKIPPED"
else
    step 3b "Verify offsets (audit + empirical drift check)"
    STEP_START=$(date +%s)
    VERIFY_FAILED=false
    if ! run "$VENV_PYTHON" "$PROJECT_ROOT/scripts/audit-video-offsets.py" --tid "$PKEY" --strict; then
        VERIFY_FAILED=true
    fi
    if ! run "$VENV_PYTHON" "$PROJECT_ROOT/scripts/verify-offset.py" --tid "$PKEY" --strict; then
        VERIFY_FAILED=true
    fi
    echo "Done ($(elapsed "$STEP_START"))"
    if $VERIFY_FAILED; then
        echo ""
        echo "ERROR: offset verification failed for transcript $PKEY — not rebuilding the DB/site."
        echo "  Mapping:            $PROCESSOR_DIR/data/video_mapping_${PKEY}.json"
        echo "  Measure at a time:  $PROJECT_ROOT/scripts/verify-offset.py --tid $PKEY --at 11:05:00AM"
        echo "  Re-run the matcher: cd $PROCESSOR_DIR && venv/bin/python scripts/build/match_whisper_to_transcript.py <video_id> data/processed/processed_transcript_${PKEY}_*.json --video-mapping data/video_mapping_${PKEY}.json"
        echo "  Bypass (not recommended): --skip-verify"
        exit 1
    fi
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

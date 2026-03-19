#!/usr/bin/env bash
#
# reprocess-2026.sh — Re-scrape and rebuild all 2026 meeting data.
#
# The agenda scraper only fetches the current week's meetings by default.
# This script pulls all 2026 OnBase meeting IDs from the SQLite database
# (or from existing JSON files) and re-scrapes each one individually.
#
# Usage:
#   ./pipeline/reprocess-2026.sh                  # Full run: scrape + mirror + transcripts + build
#   ./pipeline/reprocess-2026.sh --scrape-only     # Just re-scrape agendas
#   ./pipeline/reprocess-2026.sh --skip-mirror     # Skip R2 document mirroring
#   ./pipeline/reprocess-2026.sh --skip-transcripts # Skip transcript processing
#   ./pipeline/reprocess-2026.sh --dry-run         # Show what would be done
#   ./pipeline/reprocess-2026.sh --from-json       # Get IDs from JSON files instead of DB

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRAPER_DIR="$PROJECT_ROOT/agenda-scraper"
DB_PATH="$PROJECT_ROOT/data/meetings.db"

# Defaults
DRY_RUN=false
SCRAPE_ONLY=false
SKIP_MIRROR=false
SKIP_TRANSCRIPTS=false
FROM_JSON=false
YEAR="2026"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)          DRY_RUN=true; shift ;;
        --scrape-only)      SCRAPE_ONLY=true; shift ;;
        --skip-mirror)      SKIP_MIRROR=true; shift ;;
        --skip-transcripts) SKIP_TRANSCRIPTS=true; shift ;;
        --from-json)        FROM_JSON=true; shift ;;
        --year)             YEAR="$2"; shift 2 ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--dry-run] [--scrape-only] [--skip-mirror] [--skip-transcripts] [--from-json] [--year YYYY]"
            exit 1
            ;;
    esac
done

# ── Collect meeting IDs ────────────────────────────────────────────────────────
if $FROM_JSON; then
    echo "=== Collecting $YEAR meeting IDs from JSON files ==="
    MEETING_IDS=()
    for f in "$SCRAPER_DIR"/data/meeting_*_${YEAR}-*.json; do
        [[ -f "$f" ]] || continue
        # Extract ID from filename: meeting_2564_2026-01-08.json → 2564
        basename="$(basename "$f")"
        id="${basename#meeting_}"
        id="${id%%_*}"
        MEETING_IDS+=("$id")
    done
else
    echo "=== Collecting $YEAR meeting IDs from database ==="
    if [[ ! -f "$DB_PATH" ]]; then
        echo "ERROR: Database not found at $DB_PATH"
        echo "Run ./pipeline/build-site.sh --db-only first, or use --from-json"
        exit 1
    fi
    # Read IDs from SQLite — one per line, deduplicated
    MEETING_IDS=()
    while IFS= read -r id; do
        MEETING_IDS+=("$id")
    done < <(sqlite3 "$DB_PATH" "SELECT DISTINCT id FROM meetings WHERE date >= '${YEAR}-01-01' AND date < '$(( ${YEAR} + 1 ))-01-01' ORDER BY date")
fi

if [[ ${#MEETING_IDS[@]} -eq 0 ]]; then
    echo "No meetings found for $YEAR."
    exit 0
fi

echo "  Found ${#MEETING_IDS[@]} meetings: ${MEETING_IDS[*]}"
echo ""

# ── Phase 1: Re-scrape agendas ────────────────────────────────────────────────
echo "═══════════════════════════════════════════════"
echo "  Phase 1: Re-scrape agendas (${#MEETING_IDS[@]} meetings)"
echo "═══════════════════════════════════════════════"

SCRAPE_OK=0
SCRAPE_FAIL=0

for id in "${MEETING_IDS[@]}"; do
    echo ""
    echo "  Scraping meeting $id..."
    if $DRY_RUN; then
        echo "  [dry-run] node json-scraper.js $id"
        (( SCRAPE_OK++ ))
    else
        if (cd "$SCRAPER_DIR" && node json-scraper.js "$id" 2>&1); then
            (( SCRAPE_OK++ ))
        else
            echo "  WARNING: Failed to scrape meeting $id"
            (( SCRAPE_FAIL++ ))
        fi
    fi
done

echo ""
echo "  Scrape complete: $SCRAPE_OK succeeded, $SCRAPE_FAIL failed"

if $SCRAPE_ONLY; then
    echo ""
    echo "Done (--scrape-only)."
    exit 0
fi

# ── Phase 2: Mirror documents ─────────────────────────────────────────────────
if $SKIP_MIRROR; then
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  Phase 2: Mirror documents — SKIPPED"
    echo "═══════════════════════════════════════════════"
else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  Phase 2: Mirror documents to R2"
    echo "═══════════════════════════════════════════════"

    if $DRY_RUN; then
        echo "  [dry-run] cd agenda-scraper && node mirror-documents.js ${MEETING_IDS[*]}"
    else
        (cd "$SCRAPER_DIR" && node mirror-documents.js "${MEETING_IDS[@]}")
    fi
fi

# ── Phase 3: Rebuild entity databases ─────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Phase 3: Rebuild entity databases"
echo "═══════════════════════════════════════════════"

if $DRY_RUN; then
    echo "  [dry-run] ./pipeline/rebuild-entities.sh"
else
    "$SCRIPT_DIR/rebuild-entities.sh"
fi

# ── Phase 4: Process transcripts ──────────────────────────────────────────────
if $SKIP_TRANSCRIPTS; then
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  Phase 4: Process transcripts — SKIPPED"
    echo "═══════════════════════════════════════════════"
else
    echo ""
    echo "═══════════════════════════════════════════════"
    echo "  Phase 4: Discover and process transcripts"
    echo "═══════════════════════════════════════════════"

    VENV_PYTHON="$PROJECT_ROOT/transcript-cleaner/processor/venv/bin/python"
    if $DRY_RUN; then
        echo "  [dry-run] python3 pipeline/discover.py --process --skip-video"
    else
        "$VENV_PYTHON" "$SCRIPT_DIR/discover.py" --process --skip-video
    fi
fi

# ── Phase 5: Rebuild DB + site ────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  Phase 5: Rebuild database and site"
echo "═══════════════════════════════════════════════"

if $DRY_RUN; then
    echo "  [dry-run] ./pipeline/build-site.sh"
else
    "$SCRIPT_DIR/build-site.sh"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  All phases complete"
echo "═══════════════════════════════════════════════"

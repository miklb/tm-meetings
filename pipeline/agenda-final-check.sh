#!/usr/bin/env bash
#
# agenda-final-check.sh — Post-meeting sweep of the agenda for a date.
#
# The agenda is usually processed several times during the week before a
# meeting, but the clerk can attach documents (or revise items) right up to
# and after the meeting itself. This runs the canonical agenda pipeline once
# more (re-scrape → R2 mirror → OpenGov reconcile → tm-static Markdown) and
# reports what changed since the last run, plus any supporting document that
# still has no mirroredUrl (i.e. the agenda post would link to OnBase).
#
# Usage:
#   ./pipeline/agenda-final-check.sh <YYYY-MM-DD> [--dry-run]
#
# Called automatically as Step 0 of archive-meeting.sh (opt out with
# --skip-agenda). Safe to run standalone any time.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRAPER_DIR="$PROJECT_ROOT/agenda-scraper"
DATA_DIR="$SCRAPER_DIR/data"

DRY_RUN=false
DATE=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        *)
            if [[ "$arg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
                DATE="$arg"
            else
                echo "Unknown argument: $arg" >&2
                echo "Usage: $0 <YYYY-MM-DD> [--dry-run]" >&2
                exit 1
            fi
            ;;
    esac
done
if [[ -z "$DATE" ]]; then
    echo "Usage: $0 <YYYY-MM-DD> [--dry-run]" >&2
    exit 1
fi

# -maxdepth 1: data/changes/ stubs share the same basename as real files.
find_meeting_files() {
    find "$DATA_DIR" -maxdepth 1 -name "meeting_*_${DATE}.json" -not -name "*.bak.*" 2>/dev/null | sort
}

BEFORE_FILES=$(find_meeting_files)
if [[ -z "$BEFORE_FILES" ]]; then
    echo "No agenda JSON for $DATE in $DATA_DIR — nothing to re-check."
    echo "(Run 'cd agenda-scraper && ./process-agenda.sh $DATE' first if this meeting has an agenda.)"
    exit 0
fi

if $DRY_RUN; then
    echo "[dry-run] would re-run: cd agenda-scraper && ./process-agenda.sh $DATE"
    echo "[dry-run] would diff against:"
    echo "$BEFORE_FILES" | sed 's/^/  /'
    exit 0
fi

# ── Snapshot the current JSON so we can diff afterwards ───────────────────────
SNAP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agenda-check-${DATE}.XXXXXX")
trap 'rm -rf "$SNAP_DIR"' EXIT
while IFS= read -r f; do
    cp "$f" "$SNAP_DIR/$(basename "$f")"
done <<< "$BEFORE_FILES"

# ── Re-run the canonical agenda pipeline ──────────────────────────────────────
# Always via process-agenda.sh: the scraper rewrites the JSON, and only the
# mirror step immediately after restores the mirroredUrl stamps.
echo "Re-running agenda pipeline for $DATE (scrape → mirror → reconcile → markdown)..."
echo ""
( cd "$SCRAPER_DIR" && ./process-agenda.sh "$DATE" )
echo ""

# ── Report ────────────────────────────────────────────────────────────────────
echo "────────────────────────────────────────────────────────────"
echo "  Agenda final check — $DATE"
echo "────────────────────────────────────────────────────────────"

UNMIRRORED_TOTAL=0
CHANGED=0
AFTER_FILES=$(find_meeting_files)
while IFS= read -r f; do
    base=$(basename "$f")
    mid=$(jq -r '.meetingId // .id // "?"' "$f")
    mname=$(jq -r '.meetingName // .meetingType // ""' "$f")
    echo ""
    echo "▸ $base  (meeting $mid${mname:+ — $mname})"

    if [[ -f "$SNAP_DIR/$base" ]]; then
        # diff-without-urls exits 0 either way; its summary text says whether
        # anything meaningful changed.
        SUMMARY=$(node "$SCRAPER_DIR/diff-without-urls.js" --summary "$SNAP_DIR/$base" "$f" 2>&1 || true)
        if echo "$SUMMARY" | grep -qi "no meaningful changes"; then
            echo "  ✓ No changes since last run"
        else
            CHANGED=$((CHANGED + 1))
            echo "$SUMMARY" | sed 's/^/  /'
        fi
    else
        CHANGED=$((CHANGED + 1))
        echo "  🆕 New meeting file (not present before this run)"
    fi

    DOC_TOTAL=$(jq '[.agendaItems[]?.supportingDocuments[]?] | length' "$f")
    DOC_MIRRORED=$(jq '[.agendaItems[]?.supportingDocuments[]? | select(.mirroredUrl)] | length' "$f")
    DOC_MISSING=$((DOC_TOTAL - DOC_MIRRORED))
    UNMIRRORED_TOTAL=$((UNMIRRORED_TOTAL + DOC_MISSING))
    # Stamps restored/added this run (the JSON on disk can lose mirroredUrl
    # stamps — e.g. a nightly CI scrape commit — even when R2 already has the
    # file; the diff above ignores URL-only changes, so count them here).
    PREV_MIRRORED=0
    if [[ -f "$SNAP_DIR/$base" ]]; then
        PREV_MIRRORED=$(jq '[.agendaItems[]?.supportingDocuments[]? | select(.mirroredUrl)] | length' "$SNAP_DIR/$base")
    fi
    if [[ "$DOC_MIRRORED" -gt "$PREV_MIRRORED" ]]; then
        echo "  🔗 mirroredUrl stamps: $PREV_MIRRORED → $DOC_MIRRORED (+$((DOC_MIRRORED - PREV_MIRRORED)) this run)"
    fi
    if [[ "$DOC_MISSING" -eq 0 ]]; then
        echo "  ✓ Documents: $DOC_MIRRORED/$DOC_TOTAL mirrored to R2"
    else
        echo "  ⚠️  Documents: $DOC_MIRRORED/$DOC_TOTAL mirrored — $DOC_MISSING still link to OnBase:"
        jq -r '.agendaItems[]? | . as $it | .supportingDocuments[]? | select(.mirroredUrl | not)
               | "     item \($it.itemNumber // $it.id // "?") [\($it.fileNumber // "-")]: \(.title)"' "$f" | head -20
    fi
done <<< "$AFTER_FILES"

echo ""
if [[ "$CHANGED" -eq 0 && "$UNMIRRORED_TOTAL" -eq 0 ]]; then
    echo "✅ Agenda unchanged and fully mirrored."
else
    [[ "$CHANGED" -gt 0 ]] && echo "📝 $CHANGED meeting file(s) changed — the tm-static post was regenerated; commit + push tm-static to publish."
    [[ "$UNMIRRORED_TOTAL" -gt 0 ]] && echo "⚠️  $UNMIRRORED_TOTAL document(s) not mirrored — check the mirror output above (R2 creds? OnBase 404?) and re-run: cd agenda-scraper && node mirror-documents.js --date $DATE"
fi
echo ""

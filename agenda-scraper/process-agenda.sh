#!/bin/bash

# Tampa City Council Agenda Processing Script
# Usage: ./process-agenda.sh [date] [--skip-mirror] [--id MEETING_ID]
# If no date provided, uses today's date
# Always re-scrapes: date runs only write meetings matching the date (the
# scraper skips others before fetching their items), and the mirror step
# re-stamps mirroredUrl right after, so a re-scrape is always safe here.
# --skip-mirror  Skip mirroring documents to R2
# --id N     Scrape a specific OnBase meeting ID (required for historical
#            meetings — the scraper's date mode only sees the current list)
# --type T   Meeting type for --id scrapes (regular|evening|cra|workshop|special);
#            historical IDs can't be type-looked-up and default to regular

SKIP_MIRROR=false

# The R2 mirror step (@aws-sdk) needs Node 20+. Non-interactive shells can
# resolve to the stale system node in /usr/local/bin, which crashes mid-run.
NODE_MAJOR=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
    echo "❌ node $(node --version 2>/dev/null || echo '(not found)') is too old — need 20+."
    echo "   Fix: export PATH=\"\$HOME/.nvm/versions/node/v26.1.0/bin:\$PATH\""
    exit 1
fi

# Set the date - use provided argument or today's date
# Support both "2026-04-02" and "--2026-04-02" (npm run process -- 2026-04-02 or npm run process --2026-04-02)
ARG1="${1#--}"  # strip leading -- if present
if [ -z "$ARG1" ] || [[ ! "$ARG1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    DATE=$(date +%Y-%m-%d)
    echo "No date provided, using today: $DATE"
else
    DATE="$ARG1"
    echo "Processing date: $DATE"
fi

# Parse flags
MEETING_ID=""
MEETING_TYPE=""
PREV_ARG=""
for arg in "$@"; do
    if [ "$arg" = "--skip-mirror" ]; then
        SKIP_MIRROR=true
    fi
    if [ "$PREV_ARG" = "--id" ]; then
        MEETING_ID="$arg"
    fi
    if [ "$PREV_ARG" = "--type" ]; then
        MEETING_TYPE="$arg"
    fi
    PREV_ARG="$arg"
done

echo "Step 1: Running JSON scraper..."
echo "⏳ This may take several minutes for agendas with many supporting documents..."
if [ -n "$MEETING_ID" ] && [ -n "$MEETING_TYPE" ]; then
    node json-scraper.js "$MEETING_ID" --type "$MEETING_TYPE"
elif [ -n "$MEETING_ID" ]; then
    node json-scraper.js "$MEETING_ID"
else
    node json-scraper.js --date "$DATE"
fi

if [ $? -ne 0 ]; then
    echo "❌ JSON scraper failed"
    echo "Check the scraper output above for error details"
    exit 1
fi

echo "✓ JSON scraper completed successfully"
echo ""

# Give a brief moment for file system to catch up
sleep 1

# -maxdepth 1 keeps data/changes/ stubs out (same basename as real meeting files)
EXISTING_JSON=$(find data -maxdepth 1 -name "*${DATE}*.json" 2>/dev/null | wc -l | tr -d ' ')

if [ "$EXISTING_JSON" -gt 0 ]; then
    echo "Found $EXISTING_JSON JSON file(s) for date $DATE"

    # Step 2: Mirror documents to R2 (unless --skip-mirror)
    if [ "$SKIP_MIRROR" = "true" ]; then
        echo "⏭  Skipping document mirroring (--skip-mirror)"
    else
        echo "Step 2: Mirroring documents to R2..."
        node mirror-documents.js --date "$DATE"
        if [ $? -eq 0 ]; then
            echo "✓ Document mirroring completed"
        else
            echo "⚠️  Document mirroring had errors (non-fatal)"
        fi
        echo ""
    fi

    echo "Step 3: Reconciling financial details against OpenGov CoA..."
    # Generates opengov/data/reports/<meetingId>-<date>-funding-manifest.json
    # which render-funding.js reads to build the per-item Financial impact
    # sections. Without this step, financial sections silently disappear.
    REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
    # -maxdepth 1: data/changes/ stubs share the same basename and would
    # clobber the real funding manifest with an empty one; meeting_ prefix
    # keeps other per-date JSON (e.g. minutes) from doing the same
    MEETING_FILES=$(find "$REPO_ROOT/agenda-scraper/data" -maxdepth 1 -name "meeting_*${DATE}*.json" -not -name "*.bak.*" 2>/dev/null)
    if [ -n "$MEETING_FILES" ]; then
        if [ -f "$REPO_ROOT/.venv/bin/python3" ]; then
            (
                cd "$REPO_ROOT" && \
                # shellcheck disable=SC2086
                .venv/bin/python3 -m opengov.reconcile $MEETING_FILES
            )
            if [ $? -eq 0 ]; then
                echo "✓ Funding manifests written"
            else
                echo "⚠️  Reconciliation had errors (financial sections may be missing)"
            fi
        else
            echo "⚠️  .venv not found at $REPO_ROOT/.venv — skipping reconciliation"
            echo "    Run: python3 -m venv .venv && .venv/bin/pip install -r opengov/requirements.txt"
        fi
    else
        echo "⚠️  No meeting JSON files found for reconciliation"
    fi
    echo ""

    echo "Step 4: Converting to Markdown post (tm-static)..."
    # Writes agendas/agenda_<date>.md; also writes/updates the post in
    # $TM_STATIC_POSTS_DIR (from .env) when set. This is the sole published
    # output — WordPress generation was retired 2026-07-17.
    node json-to-markdown.js --date "$DATE"

    if [ $? -ne 0 ]; then
        echo "❌ Markdown conversion failed"
        exit 1
    fi
    echo "✓ Markdown conversion completed successfully"
    echo ""
    echo "🎉 Agenda processing complete!"
    echo "Check the agendas/ directory for the .md file(s)"
else
    echo "⚠️  No JSON files found for date $DATE"
    echo "The scraper may not have found any meetings for this date."
    echo "Check the data/ directory to see what dates are available."
    ls -la data/*.json 2>/dev/null | tail -5
fi

#!/bin/bash

# Tampa City Council Agenda Processing Script
# Usage: ./process-agenda.sh [date] [--force] [--skip-mirror]
# If no date provided, uses today's date
# --force    Re-scrape even if a JSON file for the date already exists
# --skip-mirror  Skip mirroring documents to R2

SKIP_MIRROR=false
FORCE=false

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
for arg in "$@"; do
    if [ "$arg" = "--skip-mirror" ]; then
        SKIP_MIRROR=true
    fi
    if [ "$arg" = "--force" ]; then
        FORCE=true
    fi
done

# Check if JSON already exists for this date
EXISTING_JSON=$(find data -name "*${DATE}*.json" 2>/dev/null | wc -l | tr -d ' ')

if [ "$EXISTING_JSON" -gt 0 ] && [ "$FORCE" = "false" ]; then
    echo "✓ Found $EXISTING_JSON existing JSON file(s) for $DATE — skipping scrape"
    echo "  (use --force to re-scrape)"
    echo ""
else
    if [ "$FORCE" = "true" ] && [ "$EXISTING_JSON" -gt 0 ]; then
        echo "Step 1: Re-scraping (--force)..."
    else
        echo "Step 1: Running JSON scraper..."
    fi
    echo "⏳ This may take several minutes for agendas with many supporting documents..."
    node json-scraper.js

    if [ $? -ne 0 ]; then
        echo "❌ JSON scraper failed"
        echo "Check the scraper output above for error details"
        exit 1
    fi

    echo "✓ JSON scraper completed successfully"
    echo ""

    # Give a brief moment for file system to catch up
    sleep 1

    # Re-check after scrape
    EXISTING_JSON=$(find data -name "*${DATE}*.json" 2>/dev/null | wc -l | tr -d ' ')
fi

if [ "$EXISTING_JSON" -gt 0 ]; then
    echo "Found $EXISTING_JSON JSON file(s) for date $DATE"
    echo "Step 2: Converting to WordPress markup..."
    node json-to-wordpress.js --date "$DATE"

    if [ $? -eq 0 ]; then
        echo "✓ WordPress conversion completed successfully"
        echo ""

        # Step 3: Mirror documents to R2 (unless --skip-mirror)
        if [ "$SKIP_MIRROR" = "true" ]; then
            echo "⏭  Skipping document mirroring (--skip-mirror)"
        else
            echo "Step 3: Mirroring documents to R2..."
            node mirror-documents.js --date "$DATE"
            if [ $? -eq 0 ]; then
                echo "✓ Document mirroring completed"
            else
                echo "⚠️  Document mirroring had errors (non-fatal)"
            fi
        fi

        echo ""
        echo "🎉 Agenda processing complete!"
        echo "Check the agendas/ directory for your wp.html file(s)"
    else
        echo "❌ WordPress conversion failed"
        exit 1
    fi
else
    echo "⚠️  No JSON files found for date $DATE"
    echo "The scraper may not have found any meetings for this date."
    echo "Check the data/ directory to see what dates are available."
    ls -la data/*.json 2>/dev/null | tail -5
fi

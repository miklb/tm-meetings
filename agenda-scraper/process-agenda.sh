#!/bin/bash

# Tampa City Council Agenda Processing Script
# Usage: ./process-agenda.sh [date]
# If no date provided, uses today's date

# Set the date - use provided argument or today's date
if [ -z "$1" ]; then
    DATE=$(date +%Y-%m-%d)
    echo "No date provided, using today: $DATE"
else
    DATE="$1"
    echo "Processing date: $DATE"
fi

echo "Step 1: Running JSON scraper..."
echo "⏳ This may take several minutes for agendas with many supporting documents..."
node json-scraper.js

if [ $? -eq 0 ]; then
    echo "✓ JSON scraper completed successfully"
    echo ""
    
    # Give a brief moment for file system to catch up
    sleep 1
    
    # Check if any JSON files exist for the date
    JSON_FILES=$(find data -name "*${DATE}*.json" 2>/dev/null | wc -l)
    
    if [ "$JSON_FILES" -gt 0 ]; then
        echo "Found $JSON_FILES JSON file(s) for date $DATE"
        echo "Step 2: Converting to WordPress markup..."
        node json-to-wordpress.js --date "$DATE"
        
        if [ $? -eq 0 ]; then
            echo "✓ WordPress conversion completed successfully"
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
else
    echo "❌ JSON scraper failed"
    echo "Check the scraper output above for error details"
    exit 1
fi

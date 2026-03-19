#!/usr/bin/env bash
#
# rebuild_all.sh — Regenerate all entity databases and config from agenda data.
#
# Run this whenever new agendas are scraped to keep the capitalizer up-to-date
# without manually editing any Python code or JSON config.
#
# Usage:
#   ./scripts/build/rebuild_all.sh [--agenda-dir /path/to/agendas]
#
# Default agenda directory: ../../agenda-scraper/data (relative to processor root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROCESSOR_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default agenda directory (sibling repo)
AGENDA_DIR="$PROCESSOR_DIR/../../agenda-scraper/data"

# Handle --agenda-dir flag
if [[ "${1:-}" == "--agenda-dir" ]]; then
    AGENDA_DIR="${2:?Missing path after --agenda-dir}"
fi

AGENDA_DIR="$(cd "$AGENDA_DIR" 2>/dev/null && pwd)" || {
    echo "ERROR: Agenda directory not found: $AGENDA_DIR"
    echo "Usage: $0 [--agenda-dir /path/to/agendas]"
    exit 1
}

DATA_DIR="$PROCESSOR_DIR/data"
VENV_PYTHON="$PROCESSOR_DIR/venv/bin/python"

# Verify venv exists
if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: Python venv not found at $VENV_PYTHON"
    echo "Run: python -m venv venv && pip install -r requirements.txt"
    exit 1
fi

AGENDA_COUNT=$(find "$AGENDA_DIR" -name '*.json' | wc -l | tr -d ' ')
echo "=== Rebuild All Entity Data ==="
echo "  Agenda dir:  $AGENDA_DIR ($AGENDA_COUNT JSON files)"
echo "  Output dir:  $DATA_DIR"
echo ""

# Step 1: Extract entities from agendas (people + organizations)
echo "1/4  Extracting entities from agendas..."
"$VENV_PYTHON" "$SCRIPT_DIR/extract_agenda_entities.py" \
    --agenda-dir "$AGENDA_DIR" \
    --output "$DATA_DIR/hybrid_entity_database.json"
echo ""

# Step 2: Clean the entity database
echo "2/4  Cleaning entity database..."
"$VENV_PYTHON" "$SCRIPT_DIR/clean_entity_database.py"
echo ""

# Step 3: Auto-extract acronyms from agendas into config
echo "3/4  Extracting acronyms from agendas..."
"$VENV_PYTHON" "$SCRIPT_DIR/extract_config.py" \
    --agenda-dir "$AGENDA_DIR" \
    --config "$DATA_DIR/capitalization_config.json"
echo ""

# Step 4: Verify all data files exist
echo "4/4  Verifying data files..."
MISSING=0
for f in standard_entities.json hybrid_entity_database.json capitalization_config.json; do
    if [[ -f "$DATA_DIR/$f" ]]; then
        SIZE=$(wc -c < "$DATA_DIR/$f" | tr -d ' ')
        echo "  ✓ $f ($SIZE bytes)"
    else
        echo "  ✗ $f MISSING"
        MISSING=$((MISSING + 1))
    fi
done

echo ""
if [[ $MISSING -eq 0 ]]; then
    echo "=== Rebuild complete ✓ ==="
else
    echo "=== Rebuild finished with $MISSING missing files ==="
    exit 1
fi

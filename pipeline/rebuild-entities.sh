#!/usr/bin/env bash
#
# rebuild-entities.sh — Regenerate entity databases from agenda data.
#
# Run this whenever new agendas are scraped so the capitalizer has
# up-to-date entity knowledge (people, organizations, acronyms).
#
# This is a thin wrapper around the processor's rebuild_all.sh that
# resolves paths correctly from the project root.
#
# Usage:
#   ./pipeline/rebuild-entities.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROCESSOR_DIR="$PROJECT_ROOT/transcript-cleaner/processor"

echo "=== Rebuild Entity Databases ==="
echo "  Agenda data:  $PROJECT_ROOT/agenda-scraper/data"
echo "  Entity output: $PROCESSOR_DIR/data/"
echo ""

exec "$PROCESSOR_DIR/scripts/build/rebuild_all.sh" \
    --agenda-dir "$PROJECT_ROOT/agenda-scraper/data"

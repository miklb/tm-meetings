#!/usr/bin/env bash
#
# build-site.sh — Rebuild the SQLite database and Eleventy site.
#
# Use this when transcript data has already been processed and you just
# need to regenerate the DB + HTML output.
#
# Usage:
#   ./pipeline/build-site.sh            # Rebuild DB + site
#   ./pipeline/build-site.sh --db-only  # Rebuild DB only
#   ./pipeline/build-site.sh --year 2026  # Only import 2026 meetings

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SITE_DIR="$PROJECT_ROOT/site"

DB_ONLY=false
DB_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --db-only) DB_ONLY=true; shift ;;
        --year)    DB_ARGS+=("--year" "$2"); shift 2 ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "=== Rebuild Database ==="
(
    cd "$PROJECT_ROOT"
    node scripts/build-db.js ${DB_ARGS[@]+"${DB_ARGS[@]}"}
)

if $DB_ONLY; then
    echo "Done (--db-only). Skipped site build."
    exit 0
fi

echo ""
echo "=== Rebuild Site ==="
(
    cd "$SITE_DIR"
    npx @11ty/eleventy
)

echo ""
echo "Done. Output: $SITE_DIR/_site/"

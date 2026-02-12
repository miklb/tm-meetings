#!/bin/bash
# Download all authoritative sources and build standard entity database

set -e  # Exit on error

echo "=========================================="
echo "Downloading All Authoritative Sources"
echo "=========================================="
echo ""

# Activate virtual environment
source ./venv/bin/activate

# 1. Download ISO countries (requires internet)
echo "1. Downloading ISO 3166 countries..."
./venv/bin/python3 download_iso_countries.py
echo ""

# 2. Build US states (static data)
echo "2. Building US states database..."
./venv/bin/python3 download_us_states.py
echo ""

# 3. Build federal holidays (static data)
echo "3. Building federal holidays database..."
./venv/bin/python3 download_federal_holidays.py
echo ""

# 4. Build Tampa features (static data)
echo "4. Building Tampa geographic features..."
./venv/bin/python3 download_tampa_features.py
echo ""

# 5. Build historical terms (static data)
echo "5. Building historical terms database..."
./venv/bin/python3 download_historical_terms.py
echo ""

# 6. Build religious terms (static data)
echo "6. Building religious terms database..."
./venv/bin/python3 download_religious_terms.py
echo ""

# 7. Combine all sources
echo "7. Building comprehensive standard entity database..."
./venv/bin/python3 build_standard_entities.py
echo ""

echo "=========================================="
echo "✓ All sources downloaded and combined"
echo "=========================================="
echo ""
echo "Output files in data/:"
echo "  - iso_countries.json"
echo "  - us_states.json"
echo "  - federal_holidays.json"
echo "  - tampa_features.json"
echo "  - historical_terms.json"
echo "  - religious_terms.json"
echo "  - standard_entities.json (COMBINED)"
echo ""
echo "See docs/CAPITALIZATION_SOURCES.md for source documentation"

#!/usr/bin/env bash
#
# activate.sh — Source this to activate the project Python environment.
#
# Usage:
#   source pipeline/activate.sh
#
# After activation, `python` and `python3` resolve to the processor venv
# with all dependencies (requests, beautifulsoup4, gliner, whisper, etc.).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/transcript-cleaner/processor/venv"

if [[ ! -d "$VENV_DIR" ]]; then
    echo "ERROR: Python venv not found at $VENV_DIR"
    echo "Set up with:"
    echo "  cd $PROJECT_ROOT/transcript-cleaner/processor"
    echo "  python3 -m venv venv"
    echo "  venv/bin/pip install -r requirements.txt"
    return 1 2>/dev/null || exit 1
fi

source "$VENV_DIR/bin/activate"
echo "Activated: $(python --version) at $(which python)"

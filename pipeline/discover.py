#!/usr/bin/env python3
"""
Discover — Find meetings with available transcripts that haven't been
processed yet, and optionally kick off the pipeline for them.

Workflow:
  1. Scrape the tampagov transcript index (recent meetings)
  2. Check which ones have matching OnBase agenda data in the DB
  3. Check which ones already have processed transcripts on disk
  4. Report the gap — meetings ready to process

Usage:
    # Show what's available and what's unprocessed
    python pipeline/discover.py

    # Auto-process all discovered meetings (non-interactive)
    python pipeline/discover.py --process

    # Fetch more historical pages for backfill
    python pipeline/discover.py --pages 5

    # Only show meetings for a specific date
    python pipeline/discover.py --date 2026-02-19

    # JSON output for scripting
    python pipeline/discover.py --json
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Auto-activate the processor venv if deps aren't available
_VENV_PYTHON = Path(__file__).resolve().parent.parent / "transcript-cleaner" / "processor" / "venv" / "bin" / "python"
if _VENV_PYTHON.exists() and str(_VENV_PYTHON) != sys.executable:
    try:
        import requests  # noqa: F401 — test if available
    except ImportError:
        os.execv(str(_VENV_PYTHON), [str(_VENV_PYTHON)] + sys.argv)

# Ensure pipeline/ is importable
sys.path.insert(0, str(Path(__file__).resolve().parent))
from transcript_lookup import (
    fetch_transcript_index,
    find_unprocessed,
    match_with_db,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_DIR = PROJECT_ROOT / "pipeline"
PROCESSED_DIR = PROJECT_ROOT / "transcript-cleaner" / "processor" / "data" / "processed"


def main():
    parser = argparse.ArgumentParser(description="Discover unprocessed meeting transcripts")
    parser.add_argument("--pages", type=int, default=2, help="Transcript index pages to scrape (default: 2)")
    parser.add_argument("--date", help="Filter to specific date (YYYY-MM-DD)")
    parser.add_argument("--process", action="store_true", help="Auto-process all discovered meetings")
    parser.add_argument("--skip-video", action="store_true", help="Pass --skip-video to process-meeting.sh")
    parser.add_argument("--skip-site", action="store_true", help="Pass --skip-site to each meeting (rebuild once at end)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    # 1. Fetch transcript index
    print("Fetching transcript index from tampagov.net...")
    all_meetings = fetch_transcript_index(pages=args.pages)
    print(f"  Found {len(all_meetings)} meetings on {args.pages} page(s)")

    if args.date:
        all_meetings = [m for m in all_meetings if m["date"] == args.date]

    # 2. Match against DB
    all_meetings = match_with_db(all_meetings)

    # 3. Find unprocessed
    unprocessed = find_unprocessed(all_meetings)

    # 4. Report
    if args.json:
        print(json.dumps(unprocessed, indent=2))
        return

    if not unprocessed:
        print("\nAll available transcripts are already processed.")
        # Still show the summary
        matched = [m for m in all_meetings if m.get("onbase_id")]
        done = [m for m in matched if m.get("already_matched")]
        print(f"  Total on index: {len(all_meetings)}")
        print(f"  With agenda match: {len(matched)}")
        print(f"  Already processed: {len(done)}")
        return

    print(f"\n{'pkey':<8} {'Date':<12} {'Type':<10} {'OnBase':<8} Title")
    print("-" * 70)
    for m in unprocessed:
        onbase = str(m.get("onbase_id") or "—")
        print(f"{m['pkey']:<8} {m['date']:<12} {m['meeting_type']:<10} {onbase:<8} {m['title']}")

    print(f"\n{len(unprocessed)} meeting(s) ready to process.")

    # 5. Optionally process them
    if not args.process:
        print("\nRun with --process to automatically process these meetings.")
        return

    # Only process meetings that have an OnBase match (we need agenda data)
    processable = [m for m in unprocessed if m.get("onbase_id")]
    if not processable:
        print("\nNo meetings have both a transcript AND matching agenda data.")
        return

    print(f"\nProcessing {len(processable)} meeting(s)...\n")

    process_script = str(PIPELINE_DIR / "process-meeting.sh")
    successes = []
    failures = []

    for m in processable:
        cmd = ["bash", process_script, m["pkey"], m["date"]]
        if args.skip_video:
            cmd.append("--skip-video")
        if args.skip_site or len(processable) > 1:
            # Skip per-meeting site rebuild when processing multiple;
            # we'll do one rebuild at the end
            cmd.append("--skip-site")
        if args.dry_run:
            cmd.append("--dry-run")

        print(f"\n{'='*60}")
        print(f"Processing: pkey={m['pkey']} date={m['date']} ({m['meeting_type']})")
        print(f"{'='*60}")

        try:
            subprocess.run(cmd, check=True)
            successes.append(m)
        except subprocess.CalledProcessError as e:
            print(f"FAILED: pkey={m['pkey']} — exit code {e.returncode}")
            failures.append(m)

    # Final site rebuild (unless skipped or dry-run)
    if successes and not args.skip_site and not args.dry_run:
        print(f"\n{'='*60}")
        print("Final: Rebuilding database and site")
        print(f"{'='*60}")
        build_script = str(PIPELINE_DIR / "build-site.sh")
        subprocess.run(["bash", build_script], check=True)

    # Summary
    print(f"\n{'='*60}")
    print(f"Discovery complete: {len(successes)} succeeded, {len(failures)} failed")
    if failures:
        print("Failed meetings:")
        for m in failures:
            print(f"  pkey={m['pkey']} date={m['date']} ({m['meeting_type']})")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

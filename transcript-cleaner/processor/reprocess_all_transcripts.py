#!/usr/bin/env python3
"""
Re-process all raw transcripts with the new three-layer capitalizer.
Input: data/transcripts/*.json (ALL CAPS)
Output: data/processed/*.json (properly capitalized)

Usage:
    python3 reprocess_all_transcripts.py              # all transcripts
    python3 reprocess_all_transcripts.py --year 2026  # 2026 only
"""

import argparse
import json
import logging
import os
from datetime import date
from pathlib import Path
from src.capitalize_transcript import TranscriptCapitalizer

logger = logging.getLogger(__name__)

def main():
    parser = argparse.ArgumentParser(description='Re-capitalise transcripts')
    parser.add_argument('--year', help='Only process transcripts for this year (e.g. 2026)')
    args = parser.parse_args()

    # Set up logging to a reprocess-specific log file (not per-meeting)
    import logging
    from pathlib import Path
    log_dir = Path('data/logs')
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = date.today().isoformat()
    log_path = log_dir / f"reprocess_{args.year or 'all'}_{timestamp}.log"

    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.DEBUG)
    fh = logging.FileHandler(log_path, mode='a', encoding='utf-8')
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(
        '%(asctime)s [%(levelname)-8s] %(name)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
    ))
    root.addHandler(fh)
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter('%(message)s'))
    root.addHandler(ch)

    logger.info("Log file: %s", log_path)

    # Initialize capitalizer
    logger.info("Loading capitalizer (this will load GLiNER model)...")
    capitalizer = TranscriptCapitalizer(use_gliner=True)
    logger.info("✓ Capitalizer ready")
    logger.info("")

    # Find all transcript files
    transcript_dir = Path('data/transcripts')
    output_dir = Path('data/processed')
    output_dir.mkdir(exist_ok=True)

    all_files = sorted(transcript_dir.glob('transcript_*.json'))
    if args.year:
        transcript_files = [f for f in all_files if f'_{args.year}-' in f.name]
        logger.info("Filtering for year %s: %d of %d files", args.year, len(transcript_files), len(all_files))
    else:
        transcript_files = all_files

    if not transcript_files:
        logger.info("No transcript files found in data/transcripts/")
        return

    logger.info("Found %d transcript files to process", len(transcript_files))
    logger.info("")

    # Process each file
    processed_count = 0
    skipped_count = 0

    for idx, transcript_file in enumerate(transcript_files, 1):
        # Skip the test file we created
        if '--transcript-id' in transcript_file.name:
            skipped_count += 1
            continue

        output_file = output_dir / f"processed_{transcript_file.name}"

        logger.info("[%d/%d] Processing %s...", idx, len(transcript_files), transcript_file.name)

        try:
            # Load transcript
            with open(transcript_file, 'r', encoding='utf-8') as f:
                transcript = json.load(f)

            # Check if it has the expected structure
            if 'segments' not in transcript:
                logger.warning("  ⚠️  Skipping - no 'segments' field")
                skipped_count += 1
                continue

            # Process each segment
            for segment in transcript['segments']:
                if 'text' in segment:
                    # Capitalize the text
                    segment['text'] = capitalizer.capitalize_text(segment['text'])

                if 'speaker' in segment:
                    # Capitalize speaker name (convert from ALL CAPS to Title Case)
                    speaker = segment['speaker'].strip()
                    if speaker:
                        segment['speaker'] = ' '.join(word.capitalize() for word in speaker.split())

            # Save processed transcript
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(transcript, f, indent=2, ensure_ascii=False)

            logger.info("  ✓ Wrote %d segments to %s", len(transcript['segments']), output_file.name)
            processed_count += 1

        except Exception as e:
            logger.error("  ✗ Error: %s", e)
            skipped_count += 1
            continue

    logger.info("")
    logger.info("=" * 50)
    logger.info("Processing complete!")
    logger.info("  Processed: %d files", processed_count)
    logger.info("  Skipped: %d files", skipped_count)
    logger.info("  Output: data/processed/")
    logger.info("=" * 50)

if __name__ == '__main__':
    main()

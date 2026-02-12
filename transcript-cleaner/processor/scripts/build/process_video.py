#!/usr/bin/env python3
"""
Unified Video Pipeline — Single entry point for the full video processing workflow.

Chains Steps 1-4 from VIDEO_PIPELINE.md into one command per meeting:

1. Load transcript → auto-detect meeting type
2. Call YouTube Data API to find videos → save video_mapping_<ID>.json
3. For each video part:
   a. Calculate Whisper sample duration (adaptive)
   b. Transcribe with Whisper (cached)
   c. Match to official transcript → save offset_seconds
4. Detect transcript gaps → save transcript_start_time for Part 2+
5. Print summary

Usage:
    python scripts/build/process_video.py <meeting_id> <meeting_date> [options]

Examples:
    python scripts/build/process_video.py 2645 2025-11-13
    python scripts/build/process_video.py 2645 2025-11-13 --meeting-type CRA
    python scripts/build/process_video.py 2645 2025-11-13 --dry-run
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Ensure project root is on the path so we can import src.*
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.meeting_type_detector import detect_meeting_type
from src.transcript_gap_detector import detect_gaps, save_gaps_to_mapping
from scripts.build.match_whisper_to_transcript import (
    calculate_offset,
    calculate_smart_duration,
    save_offset_to_mapping,
)

# Rate-limiting delay between consecutive yt-dlp downloads (seconds)
YTDLP_DELAY_SECONDS = 7

# Subprocess environment: ensure child processes can resolve 'from src.*'
_SUBPROCESS_ENV = {**os.environ, "PYTHONPATH": str(PROJECT_ROOT)}


def find_transcript(meeting_id: int, meeting_date: str) -> Path | None:
    """
    Locate the processed transcript file, falling back to the raw transcript.

    Searches:
        data/processed/processed_transcript_<id>_<date>.json
        data/processed/processed_transcript_<id>_*.json
        data/transcripts/transcript_<id>_<date>.json
        data/transcripts/transcript_<id>_*.json

    Returns:
        Path to the first match, or None.
    """
    search_dirs = [
        (Path("data/processed"), f"processed_transcript_{meeting_id}_{meeting_date}.json"),
        (Path("data/processed"), f"processed_transcript_{meeting_id}_*.json"),
        (Path("data/transcripts"), f"transcript_{meeting_id}_{meeting_date}.json"),
        (Path("data/transcripts"), f"transcript_{meeting_id}_*.json"),
    ]
    for directory, pattern in search_dirs:
        matches = sorted(directory.glob(pattern))
        if matches:
            return matches[0]
    return None


def fetch_videos(
    meeting_id: int,
    meeting_date: str,
    meeting_type: str | None,
    transcript_path: Path | None,
    output_path: Path,
    dry_run: bool = False,
) -> dict | None:
    """
    Step 2: Call YouTube Data API to find videos and save the mapping.

    If the mapping file already exists, loads it instead of re-fetching.

    Returns:
        The video mapping dict, or None on failure.
    """
    if output_path.exists():
        print(f"  ✓ Video mapping already exists: {output_path.name}")
        with open(output_path) as f:
            return json.load(f)

    if dry_run:
        print(f"  [dry-run] Would call YouTube API for {meeting_date}")
        return None

    # Build the command — delegate to youtube_fetcher.py's CLI
    cmd = [
        sys.executable,
        "src/youtube_fetcher.py",
        meeting_date,
        "--meeting-id", str(meeting_id),
    ]
    if meeting_type:
        cmd += ["--meeting-type", meeting_type]
    if transcript_path:
        cmd += ["--transcript", str(transcript_path)]

    print(f"  ▶ Searching YouTube for videos...")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PROJECT_ROOT), env=_SUBPROCESS_ENV)
    if result.returncode != 0:
        print(f"  ❌ YouTube fetch failed:")
        for line in result.stderr.strip().splitlines():
            print(f"     {line}")
        return None

    # Print relevant stdout lines
    for line in result.stdout.strip().splitlines():
        if line.strip():
            print(f"     {line}")

    if output_path.exists():
        with open(output_path) as f:
            return json.load(f)

    print(f"  ❌ Video mapping not created at {output_path}")
    return None


def process_single_video(
    video: dict,
    transcript_path: Path,
    mapping_path: Path,
    model: str,
    dry_run: bool = False,
) -> dict:
    """
    Steps 3a-3c for a single video part: adaptive duration → transcribe → match → save offset.

    Returns:
        A result dict with keys: video_id, part, offset, status, duration_used
    """
    video_id = video["video_id"]
    part = video.get("part", 1)
    title = video.get("title", video_id)
    existing_offset = video.get("offset_seconds")

    result = {
        "video_id": video_id,
        "part": part,
        "title": title,
        "offset": existing_offset,
        "status": "skipped",
        "duration_used": None,
    }

    # Skip if offset already calculated
    if existing_offset is not None:
        print(f"  ✓ Part {part} ({video_id}): offset already set to {existing_offset}s — skipping")
        result["status"] = "already_done"
        return result

    if dry_run:
        window = calculate_smart_duration(str(mapping_path), str(transcript_path), video_id)
        if window.start > 0:
            print(f"  [dry-run] Part {part} ({video_id}): would skip to {window.start}s, "
                  f"transcribe {window.duration}s, then match")
        else:
            print(f"  [dry-run] Part {part} ({video_id}): would transcribe {window.duration}s, then match")
        result["duration_used"] = window.duration
        result["status"] = "dry_run"
        return result

    # 3a: Calculate adaptive audio window (start offset + duration)
    window = calculate_smart_duration(str(mapping_path), str(transcript_path), video_id)
    audio_start = window.start
    duration = window.duration
    result["duration_used"] = duration

    # 3b: Transcribe with Whisper (cached)
    if audio_start > 0:
        cache_label = f"skip{audio_start}s_{duration}s"
    elif duration != 300:
        cache_label = f"{duration // 60}min"
    else:
        cache_label = ""
    cache_file = Path(f"data/whisper_cache/{video_id}_{model}{f'_{cache_label}' if cache_label else ''}.json")
    cache_file.parent.mkdir(exist_ok=True)

    if cache_file.exists():
        print(f"  ✓ Part {part}: using cached Whisper output ({cache_file.name})")
    else:
        if audio_start > 0:
            print(f"  ▶ Part {part}: skipping to {audio_start}s, transcribing {duration}s with Whisper ({model})...")
        else:
            print(f"  ▶ Part {part}: transcribing {duration}s with Whisper ({model})...")
        cmd = [
            sys.executable,
            "scripts/build/transcribe_with_whisper.py",
            video_id,
            "--duration", str(duration),
            "--model", model,
            "--output", str(cache_file),
        ]
        if audio_start > 0:
            cmd.extend(["--start", str(audio_start)])

        transcribe_result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            env=_SUBPROCESS_ENV,
        )
        if transcribe_result.returncode != 0:
            print(f"  ❌ Whisper transcription failed for Part {part}")
            for line in transcribe_result.stderr.strip().splitlines():
                print(f"     {line}")
            result["status"] = "transcription_failed"
            return result

    # 3c: Match to official transcript
    offset = calculate_offset(str(cache_file), str(transcript_path))

    if offset is not None:
        save_offset_to_mapping(str(mapping_path), video_id, offset)
        result["offset"] = int(round(offset))
        result["status"] = "success"
    else:
        print(f"  ❌ Part {part}: could not match Whisper output to transcript")
        result["status"] = "match_failed"

    return result


def run_pipeline(
    meeting_id: int,
    meeting_date: str,
    meeting_type: str | None = None,
    model: str = "base",
    min_gap_minutes: int = 60,
    dry_run: bool = False,
    skip_fetch: bool = False,
):
    """
    Run the full video processing pipeline for a single meeting.

    Args:
        meeting_id: Meeting pkey (e.g., 2645)
        meeting_date: Date string YYYY-MM-DD (e.g., "2025-11-13")
        meeting_type: Optional override (e.g., "CRA"). Auto-detected if omitted.
        model: Whisper model name (default: "base")
        min_gap_minutes: Gap threshold for transcript gap detection (default: 60)
        dry_run: If True, show what would happen without making changes
        skip_fetch: If True, skip YouTube API call (use existing mapping only)
    """
    mapping_path = Path(f"data/video_mapping_{meeting_id}.json")
    prefix = "[dry-run] " if dry_run else ""

    print(f"\n{'=' * 70}")
    print(f" {prefix}VIDEO PIPELINE — Meeting {meeting_id} ({meeting_date})")
    print(f"{'=' * 70}\n")

    # ── Step 1: Find transcript and detect meeting type ──────────────────
    print("Step 1: Locate transcript and detect meeting type")

    transcript_path = find_transcript(meeting_id, meeting_date)
    if transcript_path is None:
        print(f"  ❌ No transcript found for meeting {meeting_id} ({meeting_date})")
        print(f"     Expected: data/processed/processed_transcript_{meeting_id}_{meeting_date}.json")
        print(f"     Run scraping + capitalization first (see WORKFLOW.md steps 1-2)")
        return

    print(f"  ✓ Transcript: {transcript_path}")

    if meeting_type:
        detected_label = meeting_type
        print(f"  ✓ Meeting type: {meeting_type} (explicit override)")
    else:
        detected = detect_meeting_type(
            transcript_path=str(transcript_path),
            meeting_id=meeting_id,
        )
        detected_label = detected.label
        print(f"  ✓ Meeting type: {detected.label} (auto-detected, search: '{detected.youtube_search_term}')")

    # ── Step 2: Find YouTube videos ──────────────────────────────────────
    print(f"\nStep 2: Find YouTube videos")

    if skip_fetch and not mapping_path.exists():
        print(f"  ❌ --skip-fetch but no existing mapping at {mapping_path}")
        return

    mapping = fetch_videos(
        meeting_id, meeting_date, meeting_type, transcript_path, mapping_path, dry_run
    )
    if mapping is None and not dry_run:
        print("  ❌ Could not obtain video mapping — aborting")
        return

    if mapping:
        videos = sorted(mapping.get("videos", []), key=lambda v: v.get("part", 1))
        print(f"  ✓ {len(videos)} video(s) found:")
        for v in videos:
            print(f"     Part {v.get('part', '?')}: {v.get('title', v['video_id'])} "
                  f"({v.get('duration', 'unknown')})")
    elif dry_run:
        print("  [dry-run] Would fetch and save video mapping")
        videos = []
    else:
        videos = []

    # ── Step 3: Process each video part ──────────────────────────────────
    if videos:
        print(f"\nStep 3: Calculate offsets (Whisper → transcript matching)")

        results = []
        for i, video in enumerate(videos):
            if i > 0 and not dry_run:
                # Rate-limit yt-dlp downloads
                existing_offset = video.get("offset_seconds")
                cache_exists = _whisper_cache_exists(video["video_id"], model)
                if existing_offset is None and not cache_exists:
                    print(f"  ⏳ Rate-limit delay ({YTDLP_DELAY_SECONDS}s)...")
                    time.sleep(YTDLP_DELAY_SECONDS)

            r = process_single_video(video, transcript_path, mapping_path, model, dry_run)
            results.append(r)

    # ── Step 4: Detect transcript gaps ───────────────────────────────────
    if videos and len(videos) > 1:
        print(f"\nStep 4: Detect transcript gaps (multi-part meeting)")

        if dry_run:
            print(f"  [dry-run] Would scan for gaps ≥ {min_gap_minutes} min")
        else:
            gap_result = detect_gaps(str(transcript_path), min_gap_minutes)
            if gap_result.gaps:
                print(f"  ✓ Found {len(gap_result.gaps)} gap(s):")
                for g in gap_result.gaps:
                    print(f"     {g.end_timestamp} → {g.resume_timestamp} ({g.gap_minutes} min)")
                save_gaps_to_mapping(str(mapping_path), gap_result.gaps)
            else:
                print(f"  ℹ️  No gaps ≥ {min_gap_minutes} min — transcript appears to be single-session")
    elif videos and len(videos) == 1:
        print(f"\nStep 4: Gap detection — skipped (single video)")
    else:
        print(f"\nStep 4: Gap detection — skipped (no videos)")

    # ── Summary ──────────────────────────────────────────────────────────
    print(f"\n{'=' * 70}")
    print(f" {prefix}SUMMARY — Meeting {meeting_id} ({meeting_date})")
    print(f"{'=' * 70}")
    print(f"  Meeting type:  {detected_label}")
    print(f"  Transcript:    {transcript_path}")
    print(f"  Video mapping: {mapping_path}")

    if videos:
        # Reload mapping to get final state
        if mapping_path.exists() and not dry_run:
            with open(mapping_path) as f:
                final_mapping = json.load(f)
            final_videos = sorted(final_mapping.get("videos", []), key=lambda v: v.get("part", 1))

            all_ok = True
            for v in final_videos:
                part = v.get("part", "?")
                vid = v.get("video_id", "?")
                offset = v.get("offset_seconds")
                tst = v.get("transcript_start_time")
                offset_str = f"{offset}s" if offset is not None else "❌ missing"
                tst_str = f" | transcript_start_time={tst}" if tst else ""
                if offset is None:
                    all_ok = False
                print(f"  Part {part}: {vid}  offset={offset_str}{tst_str}")

            if all_ok:
                print(f"\n  ✅ Pipeline complete — all offsets calculated")
            else:
                print(f"\n  ⚠️  Pipeline finished with missing offsets — review above")
        elif dry_run:
            print(f"\n  [dry-run] No changes made")
    else:
        print(f"\n  ℹ️  No videos processed")

    print()


def _whisper_cache_exists(video_id: str, model: str) -> bool:
    """Check if any Whisper cache file exists for this video."""
    cache_dir = Path("data/whisper_cache")
    return any(cache_dir.glob(f"{video_id}_{model}*"))


def main():
    parser = argparse.ArgumentParser(
        description="Unified video pipeline — chains all steps for a single meeting.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full pipeline for one meeting
  python scripts/build/process_video.py 2645 2025-11-13

  # With explicit meeting type override
  python scripts/build/process_video.py 2645 2025-11-13 --meeting-type CRA

  # Dry run (show plan without making changes)
  python scripts/build/process_video.py 2645 2025-11-13 --dry-run

  # Skip YouTube API call (use existing video mapping only)
  python scripts/build/process_video.py 2645 2025-11-13 --skip-fetch

Prerequisite:
  Transcript must already be scraped and capitalized before running this.
  See WORKFLOW.md steps 1-2 for instructions.
        """,
    )

    parser.add_argument("meeting_id", type=int, help="Meeting pkey (e.g., 2645)")
    parser.add_argument("meeting_date", help="Meeting date in YYYY-MM-DD format")
    parser.add_argument(
        "--meeting-type",
        help='Override meeting type (e.g., "CRA", "Workshop"). Auto-detected if omitted.',
    )
    parser.add_argument(
        "--model",
        default="base",
        help="Whisper model: tiny, base, small, medium (default: base)",
    )
    parser.add_argument(
        "--min-gap",
        type=int,
        default=60,
        help="Minimum gap in minutes for transcript gap detection (default: 60)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would happen without making changes",
    )
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Skip YouTube API call — only use existing video mapping",
    )

    args = parser.parse_args()

    run_pipeline(
        meeting_id=args.meeting_id,
        meeting_date=args.meeting_date,
        meeting_type=args.meeting_type,
        model=args.model,
        min_gap_minutes=args.min_gap,
        dry_run=args.dry_run,
        skip_fetch=args.skip_fetch,
    )


if __name__ == "__main__":
    main()

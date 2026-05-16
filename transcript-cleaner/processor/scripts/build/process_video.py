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
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

# Ensure project root is on the path so we can import src.*
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from src.logging_config import setup_logging
from src.meeting_type_detector import detect_meeting_type
from src.transcript_gap_detector import detect_gaps, save_gaps_to_mapping
from scripts.build.match_whisper_to_transcript import (
    calculate_offset,
    calculate_smart_duration,
    save_offset_to_mapping,
)

# Rate-limiting delay between consecutive yt-dlp downloads (seconds)
YTDLP_DELAY_SECONDS = 7

logger = logging.getLogger(__name__)

# Subprocess environment: ensure child processes can resolve 'from src.*'
# and can find venv binaries (yt-dlp) on PATH
_VENV_BIN = str(Path(sys.executable).parent)
_SUBPROCESS_ENV = {
    **os.environ,
    "PYTHONPATH": str(PROJECT_ROOT),
    "PATH": f"{_VENV_BIN}:{os.environ.get('PATH', '')}",
}


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
        logger.info("  ✓ Video mapping already exists: %s", output_path.name)
        with open(output_path) as f:
            return json.load(f)

    if dry_run:
        logger.info("  [dry-run] Would call YouTube API for %s", meeting_date)
        return None

    # Build the command — delegate to youtube_fetcher.py's CLI
    cmd = [
        sys.executable,
        "src/youtube_fetcher.py",
        meeting_date,
        "--meeting-id", str(meeting_id),
        "--log-date", meeting_date,
    ]
    if meeting_type:
        cmd += ["--meeting-type", meeting_type]
    if transcript_path:
        cmd += ["--transcript", str(transcript_path)]

    logger.info("  ▶ Searching YouTube for videos...")
    logger.debug("--- Launching youtube_fetcher ---")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(PROJECT_ROOT), env=_SUBPROCESS_ENV)
    logger.debug("--- youtube_fetcher exited (rc=%d) ---", result.returncode)

    if result.returncode != 0:
        logger.error("  ❌ YouTube fetch failed:")
        for line in result.stderr.strip().splitlines():
            logger.warning("     %s", line)
        return None

    # Echo subprocess stdout to console (it was captured to suppress interleaving)
    for line in result.stdout.strip().splitlines():
        if line.strip():
            print(f"     {line}")

    if output_path.exists():
        with open(output_path) as f:
            return json.load(f)

    logger.error("  ❌ Video mapping not created at %s", output_path)
    return None


def process_single_video(
    video: dict,
    transcript_path: Path,
    mapping_path: Path,
    model: str,
    meeting_date: str,
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
        logger.info("  ✓ Part %d (%s): offset already set to %ds — skipping", part, video_id, existing_offset)
        result["status"] = "already_done"
        return result

    if dry_run:
        window = calculate_smart_duration(str(mapping_path), str(transcript_path), video_id)
        if window.start > 0:
            logger.info("  [dry-run] Part %d (%s): would skip to %ds, transcribe %ds, then match",
                        part, video_id, window.start, window.duration)
        else:
            logger.info("  [dry-run] Part %d (%s): would transcribe %ds, then match",
                        part, video_id, window.duration)
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
        logger.info("  ✓ Part %d: using cached Whisper output (%s)", part, cache_file.name)
    else:
        if audio_start > 0:
            logger.info("  ▶ Part %d: skipping to %ds, transcribing %ds with Whisper (%s)...",
                        part, audio_start, duration, model)
        else:
            logger.info("  ▶ Part %d: transcribing %ds with Whisper (%s)...", part, duration, model)
        cmd = [
            sys.executable,
            "scripts/build/transcribe_with_whisper.py",
            video_id,
            "--duration", str(duration),
            "--model", model,
            "--output", str(cache_file),
            "--log-date", meeting_date,
        ]
        if audio_start > 0:
            cmd.extend(["--start", str(audio_start)])

        logger.debug("--- Launching transcribe_with_whisper for Part %d (%s) ---", part, video_id)
        transcribe_result = subprocess.run(
            cmd,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(PROJECT_ROOT),
            env=_SUBPROCESS_ENV,
        )
        logger.debug("--- transcribe_with_whisper exited (rc=%d) ---", transcribe_result.returncode)
        if transcribe_result.returncode != 0:
            logger.error("  ❌ Whisper transcription failed for Part %d", part)
            for line in transcribe_result.stderr.strip().splitlines():
                logger.warning("     %s", line)
            result["status"] = "transcription_failed"
            return result

    # 3c: Match to official transcript
    # For Part 2+ videos, pass transcript_start_time so the matcher only
    # searches the correct portion of the transcript.
    transcript_start_time = video.get("transcript_start_time")
    offset = calculate_offset(str(cache_file), str(transcript_path),
                              transcript_start_time=transcript_start_time)

    if offset is not None:
        save_offset_to_mapping(str(mapping_path), video_id, offset)
        result["offset"] = int(round(offset))
        result["status"] = "success"
    else:
        logger.error("  ❌ Part %d: could not match Whisper output to transcript", part)
        result["status"] = "match_failed"

    return result


def run_pipeline(
    meeting_id: int,
    meeting_date: str,
    meeting_type: str | None = None,
    model: str = "small",
    min_gap_minutes: int = 60,
    dry_run: bool = False,
    skip_fetch: bool = False,
) -> bool:
    """
    Run the full video processing pipeline for a single meeting.

    Args:
        meeting_id: Meeting pkey (e.g., 2645)
        meeting_date: Date string YYYY-MM-DD (e.g., "2025-11-13")
        meeting_type: Optional override (e.g., "CRA"). Auto-detected if omitted.
        model: Whisper model name (default: "small")
        min_gap_minutes: Gap threshold for transcript gap detection (default: 60)
        dry_run: If True, show what would happen without making changes
        skip_fetch: If True, skip YouTube API call (use existing mapping only)

    Returns:
        True if all offsets were calculated (or dry-run), False on failure.
    """
    mapping_path = Path(f"data/video_mapping_{meeting_id}.json")
    prefix = "[dry-run] " if dry_run else ""

    setup_logging(meeting_date)

    logger.info("\n%s", "=" * 70)
    logger.info(" %sVIDEO PIPELINE — Meeting %d (%s)", prefix, meeting_id, meeting_date)
    logger.info("%s\n", "=" * 70)

    # ── Step 1: Find transcript and detect meeting type ──────────────────
    logger.info("Step 1: Locate transcript and detect meeting type")

    transcript_path = find_transcript(meeting_id, meeting_date)
    if transcript_path is None:
        logger.error("  ❌ No transcript found for meeting %d (%s)", meeting_id, meeting_date)
        logger.error("     Expected: data/processed/processed_transcript_%d_%s.json", meeting_id, meeting_date)
        logger.error("     Run scraping + capitalization first (see WORKFLOW.md steps 1-2)")
        return False

    logger.info("  ✓ Transcript: %s", transcript_path)

    if meeting_type:
        detected_label = meeting_type
        logger.info("  ✓ Meeting type: %s (explicit override)", meeting_type)
    else:
        detected = detect_meeting_type(
            transcript_path=str(transcript_path),
            meeting_id=meeting_id,
        )
        detected_label = detected.label
        logger.info("  ✓ Meeting type: %s (auto-detected, search: '%s')",
                    detected.label, detected.youtube_search_term)

    # ── Step 2: Find YouTube videos ──────────────────────────────────────
    logger.info("\nStep 2: Find YouTube videos")

    if skip_fetch and not mapping_path.exists():
        logger.error("  ❌ --skip-fetch but no existing mapping at %s", mapping_path)
        return False

    mapping = fetch_videos(
        meeting_id, meeting_date, meeting_type, transcript_path, mapping_path, dry_run
    )
    if mapping is None and not dry_run:
        logger.error("  ❌ Could not obtain video mapping — aborting")
        return False

    if mapping:
        videos = sorted(mapping.get("videos", []), key=lambda v: v.get("part", 1))
        logger.info("  ✓ %d video(s) found:", len(videos))
        for v in videos:
            logger.info("     Part %s: %s (%s)",
                        v.get("part", "?"), v.get("title", v["video_id"]), v.get("duration", "unknown"))
    elif dry_run:
        logger.info("  [dry-run] Would fetch and save video mapping")
        videos = []
    else:
        videos = []

    # ── Step 3: Detect transcript gaps (before offset matching) ────────
    # For multi-part meetings, detect gaps first so transcript_start_time
    # is available for Part 2+ offset matching.
    if videos and len(videos) > 1:
        logger.info("\nStep 3: Detect transcript gaps (multi-part meeting)")

        if dry_run:
            logger.info("  [dry-run] Would scan for gaps ≥ %d min", min_gap_minutes)
        else:
            gap_result = detect_gaps(str(transcript_path), min_gap_minutes)
            if gap_result.gaps:
                logger.info("  ✓ Found %d gap(s):", len(gap_result.gaps))
                for g in gap_result.gaps:
                    logger.info("     %s → %s (%s min)", g.end_timestamp, g.resume_timestamp, g.gap_minutes)
                save_gaps_to_mapping(str(mapping_path), gap_result.gaps)
                # Reload the mapping so video dicts have transcript_start_time
                with open(mapping_path) as f:
                    mapping = json.load(f)
                videos = sorted(mapping.get("videos", []), key=lambda v: v.get("part", 1))
            else:
                logger.info("  ℹ️  No gaps ≥ %d min — transcript appears to be single-session",
                            min_gap_minutes)
    elif videos and len(videos) == 1:
        logger.info("\nStep 3: Gap detection — skipped (single video)")

    # ── Step 4: Calculate offsets (Whisper → transcript matching) ─────
    if videos:
        logger.info("\nStep 4: Calculate offsets (Whisper → transcript matching)")

        results = []
        for i, video in enumerate(videos):
            if i > 0 and not dry_run:
                # Rate-limit yt-dlp downloads
                existing_offset = video.get("offset_seconds")
                cache_exists = _whisper_cache_exists(video["video_id"], model)
                if existing_offset is None and not cache_exists:
                    logger.info("  ⏳ Rate-limit delay (%ds)...", YTDLP_DELAY_SECONDS)
                    time.sleep(YTDLP_DELAY_SECONDS)

            r = process_single_video(video, transcript_path, mapping_path, model, meeting_date, dry_run)
            results.append(r)

    # ── Summary ──────────────────────────────────────────────────────────
    logger.info("\n%s", "=" * 70)
    logger.info(" %sSUMMARY — Meeting %d (%s)", prefix, meeting_id, meeting_date)
    logger.info("%s", "=" * 70)
    logger.info("  Meeting type:  %s", detected_label)
    logger.info("  Transcript:    %s", transcript_path)
    logger.info("  Video mapping: %s", mapping_path)

    all_ok = False
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
                logger.info("  Part %s: %s  offset=%s%s", part, vid, offset_str, tst_str)

            if all_ok:
                logger.info("\n  ✅ Pipeline complete — all offsets calculated")
            else:
                logger.warning("\n  ⚠️  Pipeline finished with missing offsets — review above")
        elif dry_run:
            logger.info("\n  [dry-run] No changes made")
    else:
        logger.info("\n  ℹ️  No videos processed")

    logger.info("")
    return all_ok if videos and not dry_run else True


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
        default="small",
        help="Whisper model: tiny, base, small, medium (default: small)",
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

    success = run_pipeline(
        meeting_id=args.meeting_id,
        meeting_date=args.meeting_date,
        meeting_type=args.meeting_type,
        model=args.model,
        min_gap_minutes=args.min_gap,
        dry_run=args.dry_run,
        skip_fetch=args.skip_fetch,
    )
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()

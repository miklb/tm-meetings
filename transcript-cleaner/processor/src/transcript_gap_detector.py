"""
Transcript Gap Detector — identifies multi-part video boundaries in official transcripts.

Tampa City Council meetings are sometimes split into multiple YouTube videos
(lunch break, streaming interruption, evening session). This module scans
consecutive segment timestamps to find gaps > a configurable threshold,
then maps each gap to a video part boundary.

The detected gaps populate `transcript_start_time` in the video mapping JSON,
which html_generator.py uses to assign segments to the correct video part.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class TranscriptGap:
    """A detected gap between consecutive transcript segments."""
    after_segment_index: int
    gap_minutes: float
    end_timestamp: str          # wall-clock time of the segment BEFORE the gap
    resume_timestamp: str       # wall-clock time of the segment AFTER the gap
    resume_speaker: str = ""    # who speaks first after the gap


@dataclass
class GapDetectionResult:
    """Full result of gap detection on a transcript."""
    transcript_path: str
    total_segments: int
    gaps: list[TranscriptGap] = field(default_factory=list)
    first_timestamp: str = ""   # first segment timestamp (Part 1 implicit start)


def parse_timestamp_to_minutes(timestamp: str) -> Optional[float]:
    """
    Parse a transcript wall-clock timestamp to minutes since midnight.

    Handles formats:
        9:06:03AM  → 546.05
        12:02:47PM → 722.783
        1:36:37PM  → 816.617
    """
    ts = timestamp.strip().upper()

    is_pm = "PM" in ts
    is_am = "AM" in ts
    ts = ts.replace("PM", "").replace("AM", "").strip()

    parts = ts.split(":")
    if len(parts) != 3:
        return None

    try:
        hours, minutes, seconds = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None

    # 12-hour to 24-hour conversion
    if is_pm and hours != 12:
        hours += 12
    elif is_am and hours == 12:
        hours = 0

    return hours * 60 + minutes + seconds / 60


def detect_gaps(
    transcript_path: str,
    min_gap_minutes: int = 60,
) -> GapDetectionResult:
    """
    Scan a processed transcript file for time gaps indicating video part boundaries.

    Args:
        transcript_path: Path to processed transcript JSON (list of segments).
        min_gap_minutes: Minimum gap in minutes to count as a boundary (default 60).

    Returns:
        GapDetectionResult with list of detected gaps.
    """
    path = Path(transcript_path)
    if not path.exists():
        raise FileNotFoundError(f"Transcript not found: {transcript_path}")

    with open(path, "r") as f:
        data = json.load(f)

    # Handle both raw and processed formats
    if isinstance(data, list):
        segments = data
    elif isinstance(data, dict):
        segments = data.get("segments", data.get("transcript", []))
    else:
        segments = []

    result = GapDetectionResult(
        transcript_path=str(path),
        total_segments=len(segments),
    )

    if not segments:
        return result

    # Record first timestamp for Part 1 reference
    first_ts = segments[0].get("timestamp", "")
    result.first_timestamp = first_ts

    prev_minutes = parse_timestamp_to_minutes(first_ts)
    if prev_minutes is None:
        return result

    for i in range(1, len(segments)):
        curr_ts = segments[i].get("timestamp", "")
        curr_minutes = parse_timestamp_to_minutes(curr_ts)
        if curr_minutes is None:
            continue

        gap = curr_minutes - prev_minutes

        # Handle midnight crossing (unlikely for council meetings but safe)
        if gap < 0:
            gap += 24 * 60

        if gap > min_gap_minutes:
            prev_ts = segments[i - 1].get("timestamp", "")
            speaker = segments[i].get("speaker", "")
            result.gaps.append(TranscriptGap(
                after_segment_index=i - 1,
                gap_minutes=round(gap, 1),
                end_timestamp=prev_ts,
                resume_timestamp=curr_ts,
                resume_speaker=speaker,
            ))

        prev_minutes = curr_minutes

    return result


def save_gaps_to_mapping(
    video_mapping_path: str,
    gaps: list[TranscriptGap],
) -> bool:
    """
    Write transcript_start_time into the video mapping JSON for Part 2+ videos.

    Matches gaps to video parts sequentially:
      - Gap 0 → Part 2's transcript_start_time
      - Gap 1 → Part 3's transcript_start_time
      - etc.

    Part 1 is left unchanged (implicitly starts at the first segment).

    Args:
        video_mapping_path: Path to video_mapping_<ID>.json
        gaps: Detected gaps from detect_gaps()

    Returns:
        True if any fields were updated, False otherwise
    """
    path = Path(video_mapping_path)
    if not path.exists():
        print(f"  ⚠️  Video mapping file not found: {video_mapping_path}")
        return False

    try:
        with open(path, "r") as f:
            mapping = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"  ⚠️  Could not read video mapping: {e}")
        return False

    videos = mapping.get("videos", [])
    if not videos:
        print("  ⚠️  No videos in mapping")
        return False

    # Sort videos by part number to ensure correct ordering
    videos_by_part = sorted(videos, key=lambda v: v.get("part", 1))

    # Part 2+ videos get transcript_start_time from the corresponding gap
    updated = False
    for gap_idx, gap in enumerate(gaps):
        part_num = gap_idx + 2  # gap 0 → Part 2, gap 1 → Part 3

        # Find the video entry for this part
        target_video = None
        for v in videos_by_part:
            if v.get("part") == part_num:
                target_video = v
                break

        if target_video is None:
            print(f"  ⚠️  No video entry for Part {part_num} to assign gap at {gap.resume_timestamp}")
            continue

        old_value = target_video.get("transcript_start_time")
        target_video["transcript_start_time"] = gap.resume_timestamp
        updated = True
        if old_value and old_value != gap.resume_timestamp:
            print(f"  ⚠️  Part {part_num}: transcript_start_time changed from {old_value} → {gap.resume_timestamp}")
        else:
            print(f"  ✅ Part {part_num}: transcript_start_time = {gap.resume_timestamp} "
                  f"(gap of {gap.gap_minutes} min after segment {gap.after_segment_index})")

    if not updated:
        print("  ℹ️  No gaps matched to video parts — single-part meeting?")
        return False

    with open(path, "w") as f:
        json.dump(mapping, f, indent=2)

    return True


def detect_and_save(
    transcript_path: str,
    video_mapping_path: str,
    min_gap_minutes: int = 60,
) -> GapDetectionResult:
    """
    Convenience function: detect gaps and save transcript_start_time to the mapping.

    Args:
        transcript_path: Path to processed transcript JSON
        video_mapping_path: Path to video_mapping_<ID>.json
        min_gap_minutes: Minimum gap threshold in minutes

    Returns:
        GapDetectionResult (gaps are saved as a side effect)
    """
    result = detect_gaps(transcript_path, min_gap_minutes)

    if result.gaps:
        save_gaps_to_mapping(video_mapping_path, result.gaps)
    else:
        print(f"  ℹ️  No gaps ≥ {min_gap_minutes} min detected — single-part meeting")

    return result


# --- CLI ---

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Detect time gaps in official transcripts for multi-part video boundary detection."
    )
    parser.add_argument(
        "transcript",
        help="Path to processed transcript JSON file",
    )
    parser.add_argument(
        "--video-mapping",
        help="Path to video_mapping_<ID>.json — if provided, writes transcript_start_time",
    )
    parser.add_argument(
        "--min-gap",
        type=int,
        default=60,
        help="Minimum gap in minutes to count as a boundary (default: 60)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print detected gaps without saving to mapping file",
    )

    args = parser.parse_args()

    result = detect_gaps(args.transcript, args.min_gap)

    print(f"\nTranscript: {result.transcript_path}")
    print(f"Segments:   {result.total_segments}")
    print(f"First:      {result.first_timestamp}")

    if not result.gaps:
        print(f"\nNo gaps ≥ {args.min_gap} minutes detected — single-part meeting.\n")
        return

    print(f"\nDetected {len(result.gaps)} gap(s):\n")
    for i, gap in enumerate(result.gaps):
        print(f"  Gap {i + 1}: {gap.end_timestamp} → {gap.resume_timestamp} "
              f"({gap.gap_minutes} min, after segment {gap.after_segment_index})")
        if gap.resume_speaker:
            print(f"          First speaker: {gap.resume_speaker}")

    if args.video_mapping and not args.dry_run:
        print()
        save_gaps_to_mapping(args.video_mapping, result.gaps)
    elif args.dry_run:
        print("\n  (dry-run mode — no files modified)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Tests for transcript gap detection and transcript_start_time auto-save."""

import json
import sys
import tempfile
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.transcript_gap_detector import (
    parse_timestamp_to_minutes,
    detect_gaps,
    save_gaps_to_mapping,
    detect_and_save,
    TranscriptGap,
)


def test_parse_timestamp():
    """Test wall-clock timestamp parsing."""
    passed = 0
    total = 0

    cases = [
        ("9:06:03AM",  9 * 60 + 6 + 3/60),
        ("12:02:47PM", 12 * 60 + 2 + 47/60),
        ("1:36:37PM",  13 * 60 + 36 + 37/60),
        ("12:00:00AM", 0),             # midnight
        ("12:00:00PM", 12 * 60),       # noon
        ("5:01:00PM",  17 * 60 + 1),   # evening session
    ]

    for ts, expected in cases:
        total += 1
        result = parse_timestamp_to_minutes(ts)
        if abs(result - expected) < 0.01:
            passed += 1
            print(f"  PASS: {ts} → {result:.2f} min")
        else:
            print(f"  FAIL: {ts} → {result:.2f}, expected {expected:.2f}")

    # Invalid formats
    total += 1
    if parse_timestamp_to_minutes("invalid") is None:
        passed += 1
        print("  PASS: Invalid timestamp returns None")
    else:
        print("  FAIL: Invalid timestamp should return None")

    total += 1
    if parse_timestamp_to_minutes("10:30") is None:
        passed += 1
        print("  PASS: Two-part timestamp returns None (requires H:M:S)")
    else:
        print("  FAIL: Two-part timestamp should return None")

    return passed, total


def make_transcript(segments_data):
    """Create a temp transcript JSON file from (timestamp, speaker, text) tuples."""
    segments = [
        {"timestamp": ts, "speaker": spk, "text": txt}
        for ts, spk, txt in segments_data
    ]
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump(segments, f, indent=2)
    f.close()
    return f.name


def test_single_part_no_gaps():
    """A continuous morning meeting should have no gaps."""
    path = make_transcript([
        ("9:00:00AM", "Chair", "Meeting called to order."),
        ("9:05:00AM", "Staff", "First item."),
        ("9:15:00AM", "Staff", "Second item."),
        ("9:30:00AM", "Chair", "Moving on."),
        ("9:45:00AM", "Chair", "Meeting adjourned."),
    ])
    try:
        result = detect_gaps(path)
        ok = len(result.gaps) == 0
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: No gaps in continuous morning meeting")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_lunch_break_gap():
    """A 90-minute lunch break should be detected."""
    path = make_transcript([
        ("9:00:00AM",  "Chair", "Meeting called to order."),
        ("9:15:00AM",  "Staff", "Discussion continues."),
        ("9:30:00AM",  "Chair", "Recess for lunch."),
        # 90-minute gap
        ("11:00:00AM", "Chair", "Meeting reconvened."),
        ("11:15:00AM", "Staff", "Afternoon item."),
    ])
    try:
        result = detect_gaps(path)
        ok = (
            len(result.gaps) == 1
            and result.gaps[0].resume_timestamp == "11:00:00AM"
            and result.gaps[0].end_timestamp == "9:30:00AM"
            and 85 < result.gaps[0].gap_minutes < 95
        )
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Lunch break gap detected → {result.gaps[0].resume_timestamp} "
              f"({result.gaps[0].gap_minutes} min)" if result.gaps else f"  FAIL: No gap detected")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_two_gaps_three_parts():
    """Meeting with morning, afternoon, and evening sessions = 2 gaps."""
    path = make_transcript([
        ("9:00:00AM",  "Chair", "Morning session."),
        ("9:15:00AM",  "Chair", "Still morning."),
        ("9:30:00AM",  "Chair", "End of morning."),
        # Gap 1: 2-hour lunch
        ("11:45:00AM", "Chair", "Afternoon session."),
        ("12:00:00PM", "Chair", "End of afternoon."),
        # Gap 2: 2-hour dinner
        ("5:01:00PM",  "Chair", "Evening session."),
        ("5:15:00PM",  "Chair", "Adjournment."),
    ])
    try:
        result = detect_gaps(path)
        ok = (
            len(result.gaps) == 2
            and result.gaps[0].resume_timestamp == "11:45:00AM"
            and result.gaps[1].resume_timestamp == "5:01:00PM"
        )
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Two gaps detected for three-part meeting")
        if result.gaps:
            for g in result.gaps:
                print(f"         {g.end_timestamp} → {g.resume_timestamp} ({g.gap_minutes} min)")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_custom_threshold():
    """A 45-minute gap should be caught with --min-gap 30 but not default 60."""
    path = make_transcript([
        ("9:00:00AM",  "Chair", "First half."),
        ("9:10:00AM",  "Chair", "Break."),
        # 45-minute gap
        ("9:55:00AM",  "Chair", "Resume."),
        ("10:05:00AM", "Chair", "Done."),
    ])
    try:
        # Default threshold: should not detect
        r1 = detect_gaps(path, min_gap_minutes=60)
        ok1 = len(r1.gaps) == 0

        # Lower threshold: should detect
        r2 = detect_gaps(path, min_gap_minutes=30)
        ok2 = len(r2.gaps) == 1

        ok = ok1 and ok2
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: 45-min gap: not detected at 60min threshold, detected at 30min")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_first_timestamp_recorded():
    """Result should capture the first segment's timestamp."""
    path = make_transcript([
        ("9:06:03AM", "Chair", "Call to order."),
        ("10:00:00AM", "Staff", "Item."),
    ])
    try:
        result = detect_gaps(path)
        ok = result.first_timestamp == "9:06:03AM"
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: First timestamp = {result.first_timestamp}")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_resume_speaker():
    """Gap should record who speaks first after the gap."""
    path = make_transcript([
        ("9:00:00AM",  "Chair", "Morning."),
        ("9:10:00AM",  "Chair", "Recess."),
        ("11:30:00PM", "Lynn Hurtak", "Roll call please."),
        ("11:31:00PM", "Clerk", "Yes."),
    ])
    try:
        result = detect_gaps(path)
        ok = result.gaps and result.gaps[0].resume_speaker == "Lynn Hurtak"
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Resume speaker = {result.gaps[0].resume_speaker if result.gaps else 'none'}")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_dict_format_transcript():
    """Handle transcripts stored as {'segments': [...]} or {'transcript': [...]}."""
    segments = [
        {"timestamp": "9:00:00AM", "speaker": "A", "text": "Start"},
        {"timestamp": "9:10:00AM", "speaker": "A", "text": "Before lunch"},
        {"timestamp": "11:00:00AM", "speaker": "A", "text": "After lunch"},
    ]

    # segments key
    f1 = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump({"segments": segments}, f1, indent=2)
    f1.close()

    # transcript key
    f2 = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump({"transcript": segments}, f2, indent=2)
    f2.close()

    try:
        r1 = detect_gaps(f1.name)
        r2 = detect_gaps(f2.name)
        ok = len(r1.gaps) == 1 and len(r2.gaps) == 1
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Dict-format transcripts ({len(r1.gaps)} gap, {len(r2.gaps)} gap)")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(f1.name)
        os.unlink(f2.name)


def test_empty_transcript():
    """Empty transcript should return zero gaps, not crash."""
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump([], f)
    f.close()
    try:
        result = detect_gaps(f.name)
        ok = len(result.gaps) == 0 and result.total_segments == 0
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Empty transcript → 0 segments, 0 gaps")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(f.name)


def test_missing_file():
    """Non-existent file should raise FileNotFoundError."""
    try:
        detect_gaps("/tmp/nonexistent_transcript_zzz.json")
        print("  FAIL: Should have raised FileNotFoundError")
        return (0, 1)
    except FileNotFoundError:
        print("  PASS: FileNotFoundError for missing transcript")
        return (1, 1)


# --- save_gaps_to_mapping tests ---

def make_video_mapping(videos):
    """Create a temp video mapping JSON file."""
    mapping = {"meeting_id": 9999, "meeting_date": "2025-01-01", "videos": videos}
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump(mapping, f, indent=2)
    f.close()
    return f.name


def test_save_gap_to_part2():
    """One gap should set transcript_start_time on Part 2."""
    path = make_video_mapping([
        {"video_id": "abc", "part": 1, "offset_seconds": 500},
        {"video_id": "def", "part": 2, "offset_seconds": 600},
    ])
    gap = TranscriptGap(
        after_segment_index=341,
        gap_minutes=93.0,
        end_timestamp="12:02:47PM",
        resume_timestamp="1:36:37PM",
        resume_speaker="Lynn Hurtak",
    )
    try:
        ok = save_gaps_to_mapping(path, [gap])
        with open(path) as f:
            data = json.load(f)
        p1 = data["videos"][0]
        p2 = data["videos"][1]
        ok = ok and p2.get("transcript_start_time") == "1:36:37PM"
        ok = ok and p1.get("transcript_start_time") is None  # Part 1 unchanged
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Part 2 transcript_start_time = {p2.get('transcript_start_time')}")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_save_two_gaps_three_parts():
    """Two gaps should set transcript_start_time on Part 2 and Part 3."""
    path = make_video_mapping([
        {"video_id": "v1", "part": 1, "offset_seconds": 500},
        {"video_id": "v2", "part": 2, "offset_seconds": 600},
        {"video_id": "v3", "part": 3, "offset_seconds": 700},
    ])
    gaps = [
        TranscriptGap(after_segment_index=100, gap_minutes=90, end_timestamp="11:30:00AM", resume_timestamp="1:00:00PM"),
        TranscriptGap(after_segment_index=250, gap_minutes=120, end_timestamp="3:00:00PM", resume_timestamp="5:01:00PM"),
    ]
    try:
        save_gaps_to_mapping(path, gaps)
        with open(path) as f:
            data = json.load(f)
        p2 = next(v for v in data["videos"] if v["part"] == 2)
        p3 = next(v for v in data["videos"] if v["part"] == 3)
        ok = p2["transcript_start_time"] == "1:00:00PM" and p3["transcript_start_time"] == "5:01:00PM"
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Part 2 = {p2['transcript_start_time']}, Part 3 = {p3['transcript_start_time']}")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_save_gap_no_matching_part():
    """Gap with no corresponding video part should print warning, return False."""
    path = make_video_mapping([
        {"video_id": "v1", "part": 1, "offset_seconds": 500},
        # No Part 2 video
    ])
    gap = TranscriptGap(after_segment_index=100, gap_minutes=90, end_timestamp="11:30:00AM", resume_timestamp="1:00:00PM")
    try:
        ok = save_gaps_to_mapping(path, [gap]) is False
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: Returns False when no Part 2 video exists")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(path)


def test_save_gap_missing_file():
    """Missing mapping file should return False."""
    gap = TranscriptGap(after_segment_index=100, gap_minutes=90, end_timestamp="11:00AM", resume_timestamp="1:00PM")
    ok = save_gaps_to_mapping("/tmp/nonexistent_mapping_zzz.json", [gap]) is False
    label = "PASS" if ok else "FAIL"
    print(f"  {label}: Returns False for missing mapping file")
    return (1, 1) if ok else (0, 1)


# --- Real data test ---

def test_real_transcript_2645():
    """Test on the actual meeting 2645 transcript if available."""
    candidates = [
        "data/processed/processed_transcript_2645_2025-11-13.json",
        "data/transcripts/transcript_2645_2025-11-13.json",
    ]
    transcript_path = None
    for c in candidates:
        if os.path.exists(c):
            transcript_path = c
            break

    if not transcript_path:
        print("  SKIP: Meeting 2645 transcript not available")
        return (0, 0)

    result = detect_gaps(transcript_path)
    # We know from research: there's a ~93-minute lunch gap around 12:02PM → 1:36PM
    ok = (
        len(result.gaps) >= 1
        and result.gaps[0].gap_minutes > 80
        and "1:36" in result.gaps[0].resume_timestamp
    )
    label = "PASS" if ok else "FAIL"
    print(f"  {label}: Real transcript 2645 → {len(result.gaps)} gap(s)")
    if result.gaps:
        for g in result.gaps:
            print(f"         {g.end_timestamp} → {g.resume_timestamp} ({g.gap_minutes} min)")
    return (1, 1) if ok else (0, 1)


# --- detect_and_save integration test ---

def test_detect_and_save():
    """detect_and_save should detect gaps and write transcript_start_time."""
    transcript_path = make_transcript([
        ("9:00:00AM",  "Chair", "Morning."),
        ("9:10:00AM",  "Chair", "Recess."),
        ("11:30:00AM", "Chair", "Afternoon."),
        ("11:45:00AM", "Chair", "Adjournment."),
    ])
    mapping_path = make_video_mapping([
        {"video_id": "v1", "part": 1, "offset_seconds": 500},
        {"video_id": "v2", "part": 2, "offset_seconds": 600},
    ])
    try:
        result = detect_and_save(transcript_path, mapping_path)
        with open(mapping_path) as f:
            data = json.load(f)
        p2 = next(v for v in data["videos"] if v["part"] == 2)
        ok = (
            len(result.gaps) == 1
            and p2.get("transcript_start_time") == "11:30:00AM"
        )
        label = "PASS" if ok else "FAIL"
        print(f"  {label}: detect_and_save → Part 2 transcript_start_time = {p2.get('transcript_start_time')}")
        return (1, 1) if ok else (0, 1)
    finally:
        os.unlink(transcript_path)
        os.unlink(mapping_path)


def main():
    total_passed = 0
    total_tests = 0

    print("\n=== Timestamp Parsing Tests ===\n")
    p, t = test_parse_timestamp()
    total_passed += p
    total_tests += t

    print("\n=== Gap Detection Tests ===\n")
    for test_fn in [
        test_single_part_no_gaps,
        test_lunch_break_gap,
        test_two_gaps_three_parts,
        test_custom_threshold,
        test_first_timestamp_recorded,
        test_resume_speaker,
        test_dict_format_transcript,
        test_empty_transcript,
        test_missing_file,
    ]:
        p, t = test_fn()
        total_passed += p
        total_tests += t

    print("\n=== Save to Mapping Tests ===\n")
    for test_fn in [
        test_save_gap_to_part2,
        test_save_two_gaps_three_parts,
        test_save_gap_no_matching_part,
        test_save_gap_missing_file,
    ]:
        p, t = test_fn()
        total_passed += p
        total_tests += t

    print("\n=== Integration Tests ===\n")
    p, t = test_detect_and_save()
    total_passed += p
    total_tests += t

    print("\n=== Real Data Tests ===\n")
    p, t = test_real_transcript_2645()
    total_passed += p
    total_tests += t

    print(f"\n{'✅' if total_passed == total_tests else '❌'} {total_passed}/{total_tests} tests passed\n")
    return 0 if total_passed == total_tests else 1


if __name__ == "__main__":
    sys.exit(main())

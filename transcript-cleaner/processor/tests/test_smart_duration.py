#!/usr/bin/env python3
"""Tests for adaptive Whisper sample duration (Step 4)."""

import json
import sys
import tempfile
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.build.match_whisper_to_transcript import calculate_smart_duration, AudioWindow


def _write_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f)


def _make_mapping(video_id, part, chapters=None, transcript_start_time=None):
    """Build a minimal video mapping dict."""
    entry = {
        "video_id": video_id,
        "part": part,
        "duration": "PT3H0M0S",
        "offset_seconds": 0,
        "chapters": chapters or [],
    }
    if transcript_start_time:
        entry["transcript_start_time"] = transcript_start_time
    return {"meeting_id": 9999, "meeting_date": "2025-01-01", "videos": [entry]}


def _make_transcript(first_timestamp="9:00:00AM"):
    """Build a minimal transcript dict."""
    return {
        "segments": [
            {"timestamp": first_timestamp, "speaker": "Chair", "text": "Good morning."}
        ]
    }


# ──────────────────────────────────────────────
# Part 1 scenarios
# ──────────────────────────────────────────────

def test_part1_no_chapters():
    """Part 1 with no chapters → start=0, 600s default."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Part 1, no chapters → start=0, 600s")


def test_part1_with_chapters():
    """Part 1 with chapters → still start=0, 600s."""
    chapters = [
        {"title": "Start", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 1", "timestamp": "00:05:00", "seconds": 300},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1, chapters))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Part 1, with chapters → start=0, 600s")


# ──────────────────────────────────────────────
# Part 2+ with chapters
# ──────────────────────────────────────────────

def test_part2_chapters_content_past_default():
    """Part 2 with first content chapter > 600s → chapter + 120s buffer."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 9", "timestamp": "00:11:12", "seconds": 672},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID2", 2, chapters))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID2")
        expected = 672 + 120  # 792
        assert result == AudioWindow(0, expected), f"Expected AudioWindow(0, {expected}), got {result}"
        print(f"  PASS: Part 2, chapter at 672s → start=0, {expected}s")


def test_part2_chapters_content_within_default():
    """Part 2 with first content chapter ≤ 600s → 600s default."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 66", "timestamp": "00:05:00", "seconds": 300},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID2", 2, chapters))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID2")
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Part 2, chapter at 300s → start=0, 600s (within default)")


def test_part3_chapters_long_intro():
    """Part 3 with long intro chapter → adaptive duration."""
    chapters = [
        {"title": "Start", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Resume", "timestamp": "00:14:00", "seconds": 840},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID3", 3, chapters))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID3")
        expected = 840 + 120  # 960
        assert result == AudioWindow(0, expected), f"Expected AudioWindow(0, {expected}), got {result}"
        print(f"  PASS: Part 3, chapter at 840s → start=0, {expected}s")


# ──────────────────────────────────────────────
# Part 2+ without chapters
# ──────────────────────────────────────────────

def test_part2_no_chapters():
    """Part 2 with no chapter data → 900s conservative default."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID2", 2))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID2")
        assert result == AudioWindow(0, 900), f"Expected AudioWindow(0, 900), got {result}"
        print("  PASS: Part 2, no chapters → start=0, 900s")


def test_part2_single_chapter_only():
    """Part 2 with only 'Start of Meeting' chapter (len=1) → 900s."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID2", 2, chapters))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID2")
        assert result == AudioWindow(0, 900), f"Expected AudioWindow(0, 900), got {result}"
        print("  PASS: Part 2, single chapter → start=0, 900s (treated as no chapters)")


# ──────────────────────────────────────────────
# Evening session buffer
# ──────────────────────────────────────────────

def test_evening_session_part1():
    """Evening session Part 1 at 5:01 PM → 600s (1m delay + 5m pre-roll + 3m buffer = 540 → clamped to 600)."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1))
        _write_json(tp, _make_transcript("5:01:00PM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        # 60s delay + 300 pre-roll + 180 buffer = 540 → estimated_speech=360 < 600 → no skip
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Evening Part 1 at 5:01 PM → start=0, 600s (clamped to minimum)")


def test_evening_session_part2_no_chapters():
    """Evening session Part 2 with no chapters → 900s (evening buffer removed)."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID2", 2))
        _write_json(tp, _make_transcript("6:30:00PM"))
        result = calculate_smart_duration(mp, tp, "VID2")
        # Part 2+ uses chapter/fallback logic, not transcript-based
        assert result == AudioWindow(0, 900), f"Expected AudioWindow(0, 900), got {result}"
        print("  PASS: Evening Part 2, no chapters → start=0, 900s")


def test_evening_session_part2_with_chapters():
    """Evening session Part 2 with late chapter → chapter + 120 (no extra evening buffer)."""
    chapters = [
        {"title": "Start", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 1", "timestamp": "00:12:00", "seconds": 720},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID2", 2, chapters))
        _write_json(tp, _make_transcript("5:30:00PM"))
        result = calculate_smart_duration(mp, tp, "VID2")
        expected = 720 + 120  # chapter buffer only, no evening buffer
        assert result == AudioWindow(0, expected), f"Expected AudioWindow(0, {expected}), got {result}"
        print(f"  PASS: Evening Part 2, chapter at 720s → start=0, {expected}s")


# ──────────────────────────────────────────────
# Edge cases
# ──────────────────────────────────────────────

def test_missing_mapping_file():
    """Missing mapping file → 600s fallback."""
    with tempfile.TemporaryDirectory() as d:
        tp = os.path.join(d, "transcript.json")
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration("/nonexistent/mapping.json", tp, "VID1")
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Missing mapping file → start=0, 600s fallback")


def test_video_id_not_in_mapping():
    """Video ID not found in mapping → Part 1 defaults."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("OTHER_VID", 2))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Video ID not found → start=0, 600s (defaults to Part 1)")


def test_missing_transcript_file():
    """Missing transcript → duration calculated without evening check."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        _write_json(mp, _make_mapping("VID2", 2))
        result = calculate_smart_duration(mp, "/nonexistent/transcript.json", "VID2")
        assert result == AudioWindow(0, 900), f"Expected AudioWindow(0, 900), got {result}"
        print("  PASS: Missing transcript → start=0, 900s (Part 2, no transcript)")


def test_real_meeting_2645_part2():
    """Real data: Meeting 2645 Part 2 — chapter at 672s → 792s sample."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 9: CRA25-18657", "timestamp": "00:11:12", "seconds": 672},
        {"title": "Item 11: CRA25-18681", "timestamp": "00:11:52", "seconds": 712},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("oCSGYDZXHbk", 2, chapters))
        _write_json(tp, _make_transcript("9:00:00AM"))
        result = calculate_smart_duration(mp, tp, "oCSGYDZXHbk")
        expected = 672 + 120  # 792 — captures past 630s actual offset
        assert result == AudioWindow(0, expected), f"Expected AudioWindow(0, {expected}), got {result}"
        print(f"  PASS: Real 2645 Part 2 → start=0, {expected}s (covers 630s intro)")


def test_real_meeting_2637_part2():
    """Real data: Meeting 2637 Part 2 — chapter at 506s → 600s (within default)."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 66: CM25-16989", "timestamp": "00:08:26", "seconds": 506},
    ]
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("JDkKcc-aFWY", 2, chapters))
        _write_json(tp, _make_transcript("9:06:53AM"))
        result = calculate_smart_duration(mp, tp, "JDkKcc-aFWY")
        # 506 < 600, so default applies. Morning session, no evening buffer.
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Real 2637 Part 2, chapter at 506s → start=0, 600s (within default)")


def test_afternoon_not_evening():
    """Afternoon session (1:30 PM — outside morning/evening windows) → default."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1))
        _write_json(tp, _make_transcript("1:30:00PM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        assert result == AudioWindow(0, 600), f"Expected AudioWindow(0, 600), got {result}"
        print("  PASS: Afternoon (1:30 PM) → start=0, 600s (non-standard time, default)")


# ──────────────────────────────────────────────
# Transcript-based duration (Part 1)
# ──────────────────────────────────────────────

def test_part1_late_morning_start():
    """Part 1 with first speech at 9:15:50 AM → skips b-roll, captures 5 min."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1))
        _write_json(tp, _make_transcript("9:15:50AM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        # speech_delay = 950s, estimated_speech = 300 + 950 = 1250 > 600 → skip
        # start = 1250 - 120 = 1130, duration = 120 + 180 = 300
        assert result == AudioWindow(1130, 300), f"Expected AudioWindow(1130, 300), got {result}"
        print("  PASS: Part 1, first speech at 9:15:50 AM → skip to 1130s, capture 300s")


def test_part1_typical_morning():
    """Part 1 with first speech at 9:06:03 AM → skips b-roll."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1))
        _write_json(tp, _make_transcript("9:06:03AM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        # speech_delay = 363s, estimated_speech = 300 + 363 = 663 > 600 → skip
        # start = 663 - 120 = 543, duration = 120 + 180 = 300
        assert result == AudioWindow(543, 300), f"Expected AudioWindow(543, 300), got {result}"
        print("  PASS: Part 1, first speech at 9:06 AM → skip to 543s, capture 300s")


def test_part1_evening_late_start():
    """Evening Part 1 with first speech at 5:20:06 PM → skips b-roll."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("VID1", 1))
        _write_json(tp, _make_transcript("5:20:06PM"))
        result = calculate_smart_duration(mp, tp, "VID1")
        # speech_delay = 1206s, estimated_speech = 300 + 1206 = 1506 > 600 → skip
        # start = 1506 - 120 = 1386, duration = 120 + 180 = 300
        assert result == AudioWindow(1386, 300), f"Expected AudioWindow(1386, 300), got {result}"
        print("  PASS: Evening Part 1 at 5:20 PM → skip to 1386s, capture 300s")


def test_real_meeting_2656():
    """Real data: Meeting 2656 — first speech 9:15:50 AM → skips 18+ min of b-roll."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("ABC123", 1))
        _write_json(tp, _make_transcript("9:15:50AM"))
        result = calculate_smart_duration(mp, tp, "ABC123")
        # estimated_speech = 300 + 950 = 1250 > 600 → skip
        # start = 1130, duration = 300 (5 min of audio instead of 24 min)
        assert result == AudioWindow(1130, 300), f"Expected AudioWindow(1130, 300), got {result}"
        assert result.start > 1000, "Must skip past the b-roll"
        print(f"  PASS: Real 2656 (9:15:50 AM) → skip to {result.start}s, capture {result.duration}s")


# ──────────────────────────────────────────────
# Runner
# ──────────────────────────────────────────────

def main():
    tests = [
        # Part 1 basics
        test_part1_no_chapters,
        test_part1_with_chapters,
        # Part 2+ with chapters
        test_part2_chapters_content_past_default,
        test_part2_chapters_content_within_default,
        test_part3_chapters_long_intro,
        # Part 2+ without chapters
        test_part2_no_chapters,
        test_part2_single_chapter_only,
        # Evening sessions
        test_evening_session_part1,
        test_evening_session_part2_no_chapters,
        test_evening_session_part2_with_chapters,
        # Edge cases
        test_missing_mapping_file,
        test_video_id_not_in_mapping,
        test_missing_transcript_file,
        # Real data validation
        test_real_meeting_2645_part2,
        test_real_meeting_2637_part2,
        test_afternoon_not_evening,
        # Transcript-based duration (Part 1)
        test_part1_late_morning_start,
        test_part1_typical_morning,
        test_part1_evening_late_start,
        test_real_meeting_2656,
    ]

    passed = 0
    failed = 0
    for test in tests:
        print(f"\n{test.__name__}:")
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"  FAIL: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR: {e}")
            failed += 1

    print(f"\n{'='*60}")
    print(f"Results: {passed}/{passed + failed} passed")
    if failed:
        print(f"  {failed} FAILED")
        sys.exit(1)
    else:
        print("  All tests passed! ✅")


if __name__ == "__main__":
    main()

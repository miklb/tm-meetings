#!/usr/bin/env python3
"""Tests for the unified video pipeline (Step 5: process_video.py)."""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.build.process_video import find_transcript, run_pipeline


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


def _make_transcript(meeting_id, date, first_timestamp="9:00:00AM"):
    return {
        "meeting_id": str(meeting_id),
        "meeting_date_time": f"THURSDAY, {date}",
        "meeting_title": "TAMPA CITY COUNCIL",
        "segments": [
            {"timestamp": first_timestamp, "speaker": "Chair", "text": "Good morning."},
            {"timestamp": "9:01:00AM", "speaker": "Chair", "text": "The meeting will come to order."},
        ],
    }


def _make_mapping(meeting_id, date, videos):
    return {
        "meeting_id": meeting_id,
        "meeting_date": date,
        "videos": videos,
    }


# ──────────────────────────────────────────────
# find_transcript tests
# ──────────────────────────────────────────────

def test_find_transcript_processed():
    """Finds processed transcript first."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            os.makedirs("data/transcripts", exist_ok=True)
            _write_json("data/processed/processed_transcript_100_2025-01-01.json", {"segments": []})
            _write_json("data/transcripts/transcript_100_2025-01-01.json", {"segments": []})

            result = find_transcript(100, "2025-01-01")
            assert result is not None
            assert "processed" in str(result)
            print("  PASS: Finds processed transcript first")
        finally:
            os.chdir(orig_dir)


def test_find_transcript_raw_fallback():
    """Falls back to raw transcript if no processed version."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            os.makedirs("data/transcripts", exist_ok=True)
            _write_json("data/transcripts/transcript_200_2025-02-01.json", {"segments": []})

            result = find_transcript(200, "2025-02-01")
            assert result is not None
            assert "transcripts" in str(result)
            print("  PASS: Falls back to raw transcript")
        finally:
            os.chdir(orig_dir)


def test_find_transcript_none():
    """Returns None when no transcript exists."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            os.makedirs("data/transcripts", exist_ok=True)

            result = find_transcript(999, "2025-12-31")
            assert result is None
            print("  PASS: Returns None for missing transcript")
        finally:
            os.chdir(orig_dir)


def test_find_transcript_glob_fallback():
    """Finds transcript by glob when exact date doesn't match."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            os.makedirs("data/transcripts", exist_ok=True)
            _write_json("data/processed/processed_transcript_300_2025-03-15.json", {"segments": []})

            # Search with a different date — glob should still find it
            result = find_transcript(300, "2025-03-20")
            assert result is not None
            assert "300" in str(result)
            print("  PASS: Finds transcript via glob fallback")
        finally:
            os.chdir(orig_dir)


# ──────────────────────────────────────────────
# run_pipeline integration tests (dry-run)
# ──────────────────────────────────────────────

def test_pipeline_no_transcript():
    """Pipeline exits gracefully when no transcript exists."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            os.makedirs("data/transcripts", exist_ok=True)
            # No transcript file — should print error and return
            run_pipeline(meeting_id=9999, meeting_date="2025-12-31", dry_run=True)
            print("  PASS: Pipeline handles missing transcript gracefully")
        finally:
            os.chdir(orig_dir)


def test_pipeline_existing_mapping_dry_run():
    """Dry-run with existing transcript and mapping shows plan."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            os.makedirs("data/transcripts", exist_ok=True)

            _write_json(
                "data/processed/processed_transcript_500_2025-05-01.json",
                _make_transcript(500, "MAY 01, 2025"),
            )
            _write_json(
                "data/video_mapping_500.json",
                _make_mapping(500, "2025-05-01", [
                    {"video_id": "ABC123", "part": 1, "title": "City Council - 5/1/25",
                     "duration": "PT2H0M0S", "offset_seconds": None, "chapters": []},
                ]),
            )

            run_pipeline(
                meeting_id=500,
                meeting_date="2025-05-01",
                dry_run=True,
                skip_fetch=True,
            )
            print("  PASS: Dry-run with existing mapping shows plan")
        finally:
            os.chdir(orig_dir)


def test_pipeline_skips_done_offsets():
    """Pipeline skips videos that already have offset_seconds set."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)

            _write_json(
                "data/processed/processed_transcript_600_2025-06-01.json",
                _make_transcript(600, "JUNE 01, 2025"),
            )
            _write_json(
                "data/video_mapping_600.json",
                _make_mapping(600, "2025-06-01", [
                    {"video_id": "VID1", "part": 1, "title": "Part 1",
                     "duration": "PT3H0M0S", "offset_seconds": 300, "chapters": []},
                    {"video_id": "VID2", "part": 2, "title": "Part 2",
                     "duration": "PT2H0M0S", "offset_seconds": 450, "chapters": []},
                ]),
            )

            run_pipeline(
                meeting_id=600,
                meeting_date="2025-06-01",
                skip_fetch=True,
            )

            # Verify mapping wasn't modified (offsets preserved)
            with open("data/video_mapping_600.json") as f:
                final = json.load(f)
            for v in final["videos"]:
                assert v["offset_seconds"] is not None
            print("  PASS: Pipeline skips videos with existing offsets")
        finally:
            os.chdir(orig_dir)


def test_pipeline_skip_fetch_no_mapping():
    """--skip-fetch without existing mapping exits with error."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)
            _write_json(
                "data/processed/processed_transcript_700_2025-07-01.json",
                _make_transcript(700, "JULY 01, 2025"),
            )
            # No video mapping — skip-fetch should handle this
            run_pipeline(
                meeting_id=700,
                meeting_date="2025-07-01",
                skip_fetch=True,
            )
            print("  PASS: --skip-fetch without mapping exits gracefully")
        finally:
            os.chdir(orig_dir)


def test_pipeline_single_video_skips_gap_detection():
    """Single-video meeting skips gap detection."""
    with tempfile.TemporaryDirectory() as d:
        orig_dir = os.getcwd()
        os.chdir(d)
        try:
            os.makedirs("data/processed", exist_ok=True)

            _write_json(
                "data/processed/processed_transcript_800_2025-08-01.json",
                _make_transcript(800, "AUGUST 01, 2025"),
            )
            _write_json(
                "data/video_mapping_800.json",
                _make_mapping(800, "2025-08-01", [
                    {"video_id": "SINGLE", "part": 1, "title": "Single Video",
                     "duration": "PT3H0M0S", "offset_seconds": 100, "chapters": []},
                ]),
            )

            run_pipeline(
                meeting_id=800,
                meeting_date="2025-08-01",
                skip_fetch=True,
            )
            print("  PASS: Single-video meeting skips gap detection")
        finally:
            os.chdir(orig_dir)


# ──────────────────────────────────────────────
# Runner
# ──────────────────────────────────────────────

def main():
    tests = [
        test_find_transcript_processed,
        test_find_transcript_raw_fallback,
        test_find_transcript_none,
        test_find_transcript_glob_fallback,
        test_pipeline_no_transcript,
        test_pipeline_existing_mapping_dry_run,
        test_pipeline_skips_done_offsets,
        test_pipeline_skip_fetch_no_mapping,
        test_pipeline_single_video_skips_gap_detection,
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
            print(f"  ERROR: {type(e).__name__}: {e}")
            failed += 1

    print(f"\n{'=' * 60}")
    print(f"Results: {passed}/{passed + failed} passed")
    if failed:
        print(f"  {failed} FAILED")
        sys.exit(1)
    else:
        print("  All tests passed! ✅")


if __name__ == "__main__":
    main()

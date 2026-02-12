#!/usr/bin/env python3
"""Tests for meeting type auto-detection and offset auto-save."""

import json
import tempfile
from pathlib import Path

from src.meeting_type_detector import (
    MeetingType,
    detect_meeting_type,
    get_legacy_search_terms,
)
from scripts.build.match_whisper_to_transcript import save_offset_to_mapping


# ---------------------------------------------------------------------------
# Meeting type detection
# ---------------------------------------------------------------------------

def test_detect_from_title_workshop():
    data = {
        "meeting_title": "TAMPA CITY COUNCIL WORKSHOPS",
        "meeting_date_time": "THURSDAY, OCTOBER 30, 2025, 9:00 A.M.",
        "segments": [],
    }
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "Workshop", f"Expected Workshop, got {result.label}"
    print("  PASS: Workshop detected from title")


def test_detect_from_title_city_council():
    data = {
        "meeting_title": "TAMPA CITY COUNCIL",
        "meeting_date_time": "THURSDAY, OCTOBER 9, 2025, 9:00 A.M.",
        "segments": [],
    }
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "City Council", f"Expected City Council, got {result.label}"
    print("  PASS: City Council detected from title")


def test_detect_cra_from_segment_text():
    data = {
        "meeting_title": "TAMPA CITY COUNCIL",  # Title doesn't say CRA
        "meeting_date_time": "THURSDAY, NOVEMBER 13, 2025, 9:00 A.M.",
        "segments": [
            {"timestamp": "9:01:40AM", "speaker": "CHAIR", "text": "GOOD MORNING"},
            {"timestamp": "9:01:45AM", "speaker": "CHAIR", "text": "WELCOME TO THE CRA MEETING TODAY"},
        ],
    }
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "CRA", f"Expected CRA, got {result.label}"
    assert result.youtube_search_term == "Community Redevelopment"
    print("  PASS: CRA detected from segment text")


def test_detect_evening_from_time():
    data = {
        "meeting_title": "TAMPA CITY COUNCIL",
        "meeting_date_time": "THURSDAY, NOVEMBER 13, 2025, 5:01 P.M.",
        "segments": [
            {"timestamp": "5:05:00PM", "speaker": "CHAIR", "text": "GOOD EVENING EVERYONE"},
        ],
    }
    # Title says generic "CITY COUNCIL", segment text has no specific type,
    # but scheduled time is 5:01 P.M. → detected as Evening.
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "Evening", f"Expected Evening, got {result.label}"
    assert result.youtube_search_term == "City Council"
    print(f"  PASS: Evening detected from 5:01 P.M. scheduled time")


def test_detect_cra_from_title():
    data = {
        "meeting_title": "TAMPA CITY COUNCIL CRA MEETING",
        "meeting_date_time": "THURSDAY, NOVEMBER 13, 2025, 9:00 A.M.",
        "segments": [],
    }
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "CRA", f"Expected CRA, got {result.label}"
    assert result.youtube_search_term == "Community Redevelopment"
    print("  PASS: CRA detected from title containing 'CRA'")


def test_detect_special_from_title():
    data = {
        "meeting_title": "TAMPA CITY COUNCIL SPECIAL DISCUSSION",
        "meeting_date_time": "TUESDAY, DECEMBER 3, 2025, 2:00 P.M.",
        "segments": [],
    }
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "Special", f"Expected Special, got {result.label}"
    print("  PASS: Special detected from title")


def test_fallback_default():
    data = {
        "meeting_title": "",
        "meeting_date_time": "",
        "segments": [],
    }
    result = detect_meeting_type(transcript_data=data)
    assert result.label == "City Council"
    assert result.youtube_search_term == "City Council"
    print("  PASS: Default fallback to City Council")


def test_detect_from_real_transcript():
    """Test against a real transcript file if available."""
    candidates = [
        Path("data/transcripts/transcript_2640_2025-10-30.json"),
        Path("data/transcripts/transcript_2645_2025-11-13.json"),
    ]
    for path in candidates:
        if path.exists():
            result = detect_meeting_type(transcript_path=str(path))
            print(f"  PASS: Real file {path.name} → {result.label} (search: '{result.youtube_search_term}')")
            return
    print("  SKIP: No real transcript files available")


def test_legacy_search_terms():
    cra = MeetingType(label="CRA", youtube_search_term="Community Redevelopment")
    terms = get_legacy_search_terms(cra)
    assert "TCC" in terms, f"Expected 'TCC' in legacy terms, got {terms}"
    print(f"  PASS: Legacy terms for CRA: {terms}")

    cc = MeetingType(label="City Council", youtube_search_term="City Council")
    terms = get_legacy_search_terms(cc)
    assert "TCC" in terms
    print(f"  PASS: Legacy terms for City Council: {terms}")


def test_metadata_lookup():
    """Test metadata lookup with a temporary metadata file."""
    metadata = {
        "meetings": [
            {"meetingId": 9999, "meetingType": "CRA Regular", "date": "2025-01-01"},
            {"meetingId": 9998, "meetingType": "evening", "date": "2025-01-02"},
            {"meetingId": 9997, "meetingType": "workshop", "date": "2025-01-03"},
        ]
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(metadata, f)
        tmp_path = f.name

    try:
        result = detect_meeting_type(meeting_id=9999, metadata_path=tmp_path)
        assert result.label == "CRA", f"Expected CRA, got {result.label}"
        print("  PASS: Metadata lookup → CRA")

        result = detect_meeting_type(meeting_id=9998, metadata_path=tmp_path)
        assert result.label == "Evening", f"Expected Evening, got {result.label}"
        print("  PASS: Metadata lookup → Evening")

        result = detect_meeting_type(meeting_id=9997, metadata_path=tmp_path)
        assert result.label == "Workshop", f"Expected Workshop, got {result.label}"
        print("  PASS: Metadata lookup → Workshop")
    finally:
        Path(tmp_path).unlink()


# ---------------------------------------------------------------------------
# Offset auto-save
# ---------------------------------------------------------------------------

def test_save_offset_to_mapping():
    """Test writing offset back to video mapping JSON."""
    mapping = {
        "meeting_id": 9999,
        "meeting_date": "2025-01-01",
        "videos": [
            {"video_id": "abc123", "title": "Test Part 1", "part": 1},
            {"video_id": "def456", "title": "Test Part 2", "part": 2},
        ],
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(mapping, f)
        tmp_path = f.name

    try:
        # Save offset for Part 1
        result = save_offset_to_mapping(tmp_path, "abc123", 552.3)
        assert result is True, "save_offset_to_mapping should return True"

        # Verify
        with open(tmp_path) as f:
            updated = json.load(f)
        assert updated["videos"][0]["offset_seconds"] == 552
        assert "offset_seconds" not in updated["videos"][1]
        print("  PASS: Offset saved for Part 1, Part 2 unchanged")

        # Save offset for Part 2
        result = save_offset_to_mapping(tmp_path, "def456", 630.7)
        assert result is True

        with open(tmp_path) as f:
            updated = json.load(f)
        assert updated["videos"][0]["offset_seconds"] == 552
        assert updated["videos"][1]["offset_seconds"] == 631
        print("  PASS: Offset saved for Part 2, Part 1 preserved")
    finally:
        Path(tmp_path).unlink()


def test_save_offset_missing_video_id():
    """Test that saving with unknown video_id returns False."""
    mapping = {
        "meeting_id": 9999,
        "videos": [{"video_id": "abc123", "title": "Test", "part": 1}],
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(mapping, f)
        tmp_path = f.name

    try:
        result = save_offset_to_mapping(tmp_path, "NONEXISTENT", 100)
        assert result is False, "Should return False for missing video ID"
        print("  PASS: Returns False for unknown video_id")
    finally:
        Path(tmp_path).unlink()


def test_save_offset_missing_file():
    """Test that saving to nonexistent file returns False."""
    result = save_offset_to_mapping("/tmp/nonexistent_mapping.json", "abc", 100)
    assert result is False
    print("  PASS: Returns False for missing file")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("\n=== Meeting Type Detection Tests ===\n")
    test_detect_from_title_workshop()
    test_detect_from_title_city_council()
    test_detect_cra_from_segment_text()
    test_detect_evening_from_time()
    test_detect_cra_from_title()
    test_detect_special_from_title()
    test_fallback_default()
    test_detect_from_real_transcript()
    test_legacy_search_terms()
    test_metadata_lookup()

    print("\n=== Offset Auto-Save Tests ===\n")
    test_save_offset_to_mapping()
    test_save_offset_missing_video_id()
    test_save_offset_missing_file()

    print("\n✅ All tests passed\n")

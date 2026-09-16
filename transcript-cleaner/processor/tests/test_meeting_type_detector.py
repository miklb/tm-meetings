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

    def by_date(header, **kw):
        # meeting_id is deliberately a pkey that matches nothing / the wrong entry
        return detect_meeting_type(transcript_data={"meeting_date_time": header, "segments": []},
                                   meeting_id=9998, metadata_path=tmp_path, **kw)

    try:
        with tempfile.TemporaryDirectory() as no_agendas:
            assert by_date("WEDNESDAY, JANUARY 1, 2025", agenda_dir=Path(no_agendas)).label == "CRA"
            assert by_date("THURSDAY, JANUARY 2, 2025", agenda_dir=Path(no_agendas)).label == "Evening"
            assert by_date("FRIDAY, JANUARY 3, 2025", agenda_dir=Path(no_agendas)).label == "Workshop"
            # A date with no entry: the pkey 9998 must not be used as a key → default
            assert by_date("SATURDAY, JANUARY 4, 2025", agenda_dir=Path(no_agendas)).label == "City Council"
    finally:
        Path(tmp_path).unlink()


def _agenda(agenda_dir, name, **record):
    (agenda_dir / name).write_text(json.dumps({"agendaItems": [], **record}))


def test_agenda_json_lookup():
    """Signal 0 joins the agenda scrape by the transcript's DATE. Transcript
    pkeys and OnBase meeting ids are different id spaces, so meeting_id is
    never used for this lookup."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        agenda_dir = Path(tmp_dir)
        none = str(agenda_dir / "none.json")
        # "CRA Special Call": the scraper's enum says 'special', the clerk says CRA
        _agenda(agenda_dir, "meeting_9996_2026-08-27.json", meetingId="9996",
                meetingType="special", meetingName="CRA Special Call", meetingTime="09:00")
        # Pre-2026-08 scrape: no meetingName → agenda JSON is not a signal
        _agenda(agenda_dir, "meeting_9995_2025-01-01.json", meetingId="9995", meetingType="cra")

        # Date from the clerk's header line; transcript title is generic
        data = {"meeting_title": "TAMPA CITY COUNCIL", "segments": [],
                "meeting_date_time": "THURSDAY, AUGUST 27, 2026, 9:00 A.M."}
        result = detect_meeting_type(transcript_data=data, meeting_id=2701,
                                     agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "CRA", f"Expected CRA, got {result.label}"
        assert result.youtube_search_term == "Community Redevelopment"

        # Date from the file name when the header carries none
        tpath = agenda_dir / "transcript_2701_2026-08-27.json"
        tpath.write_text(json.dumps({"meeting_title": "TAMPA CITY COUNCIL", "segments": []}))
        result = detect_meeting_type(transcript_path=str(tpath), agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "CRA", f"Expected CRA from file-name date, got {result.label}"

        # No meetingName on that date's scrape: falls through to transcript signals
        data = {"meeting_title": "TAMPA CITY COUNCIL", "segments": [],
                "meeting_date_time": "WEDNESDAY, JANUARY 1, 2025, 9:00 A.M."}
        result = detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "City Council", f"Expected City Council, got {result.label}"

        # Missing agenda dir: no crash, normal fallback
        result = detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir / "missing", metadata_path=none)
        assert result.label == "City Council"


def test_agenda_json_lookup_ignores_pkey_coincidence():
    """9/10/26 regression: transcript pkey 2703 must not read
    meeting_2703_2025-10-30.json (an unrelated OnBase id that happens to match)."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        agenda_dir = Path(tmp_dir)
        none = str(agenda_dir / "none.json")
        _agenda(agenda_dir, "meeting_2703_2025-10-30.json", meetingId="2703",
                meetingType="evening", meetingName="City Council Evening", meetingTime="17:01")
        _agenda(agenda_dir, "meeting_2930_2026-09-10.json", meetingId="2930",
                meetingType="cra", meetingName="CRA Regular Session", meetingTime="09:00")

        cra = {"meeting_title": None, "segments": [],
               "meeting_date_time": "THURSDAY, SEPTEMBER 10, 2026, 9:00 A.M."}
        result = detect_meeting_type(transcript_data=cra, meeting_id=2703,
                                     agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "CRA", f"pkey coincidence leaked: got {result.label}"

        # No agenda on the transcript's date at all: the coincidental file is still ignored
        other = {"meeting_title": None, "segments": [],
                 "meeting_date_time": "THURSDAY, SEPTEMBER 17, 2026, 9:00 A.M."}
        result = detect_meeting_type(transcript_data=other, meeting_id=2703,
                                     agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "City Council", f"Expected default, got {result.label}"


def test_agenda_generic_name_defers_to_time():
    """9/8/26: the clerk names it "City Council Budget Public Hearing" (generic),
    the header says 5:01 P.M. → Evening, as the transcript title rule works.
    A specific clerk name still wins outright."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        agenda_dir = Path(tmp_dir)
        none = str(agenda_dir / "none.json")
        _agenda(agenda_dir, "meeting_2929_2026-09-08.json", meetingId="2929",
                meetingType="evening", meetingName="City Council Budget Public Hearing", meetingTime="17:01")
        data = {"meeting_title": None, "segments": [],
                "meeting_date_time": "TUESDAY, SEPTEMBER 8, 2026, 5:01 P.M."}
        result = detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "Evening", f"Expected Evening, got {result.label}"

        # Same generic name at a daytime hour, nothing more specific anywhere → City Council
        data["meeting_date_time"] = "TUESDAY, SEPTEMBER 8, 2026, 9:00 A.M."
        result = detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "City Council", f"Expected City Council, got {result.label}"

        # Generic clerk name is still the clerk's record: a combined-day title
        # ("TAMPA CITY COUNCIL AND CRA", 8/27/26) or CRA chatter in the opening
        # segments does not override an unambiguous agenda match
        data["meeting_title"] = "TAMPA CITY COUNCIL AND CRA"
        data["segments"] = [{"text": "WELCOME TO THE CRA MEETING"}]
        result = detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "City Council", f"Expected clerk's City Council, got {result.label}"


def test_agenda_unnamed_sibling_blocks_the_named_one():
    """1/29/26: a 9 AM workshop transcript, agendas = an unnamed regular scrape and
    a named 'City Council Evening', neither timed. The named file is not this
    meeting; Signal 0 must stand down and the title says Workshop."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        agenda_dir = Path(tmp_dir)
        none = str(agenda_dir / "none.json")
        _agenda(agenda_dir, "meeting_2674_2026-01-29.json", meetingId="2674", meetingType="regular")
        _agenda(agenda_dir, "meeting_2759_2026-01-29.json", meetingId="2759",
                meetingType="regular", meetingName="City Council Evening")
        data = {"meeting_title": "TAMPA CITY COUNCIL WORKSHOPS", "segments": [],
                "meeting_date_time": "THURSDAY, JANUARY 29, 2026, 9:00 A.M."}
        result = detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none)
        assert result.label == "Workshop", f"Expected Workshop, got {result.label}"

        # Give both files times and the join works again: 9:00 → the regular one,
        # which is unnamed → still no Signal 0 → Workshop from the title
        for name, time in (("meeting_2674_2026-01-29.json", "09:00"), ("meeting_2759_2026-01-29.json", "17:01")):
            record = json.loads((agenda_dir / name).read_text()); record["meetingTime"] = time
            (agenda_dir / name).write_text(json.dumps(record))
        assert detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none).label == "Workshop"
        data["meeting_date_time"] = "THURSDAY, JANUARY 29, 2026, 5:01 P.M."
        data["meeting_title"] = None
        assert detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir, metadata_path=none).label == "Evening"


def test_agenda_json_lookup_two_meetings_one_day():
    """CRA 09:00 and Evening 17:01 on the same date, plus an addendum file for
    the evening: the transcript's scheduled time picks the meeting."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        agenda_dir = Path(tmp_dir)
        none = str(agenda_dir / "none.json")
        _agenda(agenda_dir, "meeting_2930_2026-09-10.json", meetingId="2930",
                meetingType="cra", meetingName="CRA Regular Session", meetingTime="09:00")
        _agenda(agenda_dir, "meeting_2951_2026-09-10.json", meetingId="2951",
                meetingType="evening", meetingName="City Council Evening", meetingTime="17:01")
        _agenda(agenda_dir, "meeting_2960_2026-09-10.json", meetingId="2960", isAddendum=True,
                meetingType="evening", meetingName="City Council Evening", meetingTime="17:01")

        def detect(header, **kw):
            data = {"meeting_title": None, "segments": [], "meeting_date_time": header}
            return detect_meeting_type(transcript_data=data, agenda_dir=agenda_dir,
                                       metadata_path=none, **kw)

        assert detect("THURSDAY, SEPTEMBER 10, 2026, 9:00 A.M.").label == "CRA"
        assert detect("THURSDAY, SEPTEMBER 10, 2026, 5:01 P.M.").label == "Evening"
        # Nearest time wins when the clerk's clock and the header disagree a little
        assert detect("THURSDAY, SEPTEMBER 10, 2026, 5:15 P.M.").label == "Evening"
        # A time hours from every agenda is not one of these meetings
        assert detect("THURSDAY, SEPTEMBER 10, 2026, 1:00 P.M.").label == "City Council"
        # No time on the transcript: ambiguous, fall through (generic title → default)
        assert detect("THURSDAY, SEPTEMBER 10, 2026").label == "City Council"

        # Agendas without meetingTime cannot be told apart by time → fall through,
        # and the evening header's own time still yields Evening via Signal 3
        for name in ("meeting_2930_2026-09-10.json", "meeting_2951_2026-09-10.json", "meeting_2960_2026-09-10.json"):
            record = json.loads((agenda_dir / name).read_text())
            record.pop("meetingTime")
            (agenda_dir / name).write_text(json.dumps(record))
        assert detect("THURSDAY, SEPTEMBER 10, 2026, 9:00 A.M.").label == "CRA"
        assert detect("THURSDAY, SEPTEMBER 10, 2026, 5:01 P.M.").label == "Evening"
        assert detect("THURSDAY, SEPTEMBER 10, 2026").label == "City Council"


def test_agenda_untimed_siblings_split_by_evening_label():
    """9/11/25: 'CRA Regular' + 'City Council Evening' (+ its addendum), none timed.
    A 10:15 A.M. transcript is the daytime one → CRA. Both old code paths got
    this wrong (pkey collisions) and it needed a manual override."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        agenda_dir = Path(tmp_dir)
        none = str(agenda_dir / "none.json")
        _agenda(agenda_dir, "meeting_2637_2025-09-11.json", meetingId="2637", meetingType="cra", meetingName="CRA Regular")
        _agenda(agenda_dir, "meeting_2669_2025-09-11.json", meetingId="2669", meetingType="evening", meetingName="City Council Evening")
        _agenda(agenda_dir, "meeting_2693_2025-09-11.json", meetingId="2693", meetingType="evening",
                meetingName="City Council Evening Addendum", isAddendum=True)

        def detect(header):
            return detect_meeting_type(transcript_data={"meeting_date_time": header, "segments": []},
                                       agenda_dir=agenda_dir, metadata_path=none, meeting_id=2631)

        assert detect("THURSDAY, SEPTEMBER 11, 2025, 10:15 A.M.").label == "CRA"
        assert detect("THURSDAY, SEPTEMBER 11, 2025, 5:01 P.M.").label == "Evening"

        # Two daytime meetings with different names and no times: still ambiguous
        _agenda(agenda_dir, "meeting_2638_2025-09-11.json", meetingId="2638", meetingType="workshop", meetingName="City Council Workshop")
        assert detect("THURSDAY, SEPTEMBER 11, 2025, 10:15 A.M.").label == "City Council"


def test_metadata_enum_values():
    """The scraper's bare enum values ('cra', 'special') resolve via metadata."""
    metadata = {
        "meetings": [
            {"meetingId": 9994, "meetingType": "cra", "date": "2025-02-01"},
            {"meetingId": 9993, "meetingType": "special", "date": "2025-02-02"},
            {"meetingId": 9992, "meetingType": "special", "meetingName": "CRA Special Call Session", "date": "2025-02-03"},
        ]
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump(metadata, f)
        tmp_path = f.name

    try:
        missing = Path(tmp_path).parent / "no-agenda-dir"
        def by_date(header):
            return detect_meeting_type(transcript_data={"meeting_date_time": header, "segments": []},
                                       metadata_path=tmp_path, agenda_dir=missing)
        result = by_date("SATURDAY, FEBRUARY 1, 2025")
        assert result.label == "CRA", f"Expected CRA, got {result.label}"
        result = by_date("SUNDAY, FEBRUARY 2, 2025")
        assert result.label == "Special", f"Expected Special, got {result.label}"
        # meetingName beats the enum
        result = by_date("MONDAY, FEBRUARY 3, 2025")
        assert result.label == "CRA", f"Expected CRA from meetingName, got {result.label}"
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
    test_agenda_json_lookup()
    test_metadata_enum_values()

    print("\n=== Offset Auto-Save Tests ===\n")
    test_save_offset_to_mapping()
    test_save_offset_missing_video_id()
    test_save_offset_missing_file()

    print("\n✅ All tests passed\n")

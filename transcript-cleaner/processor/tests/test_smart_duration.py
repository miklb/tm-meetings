#!/usr/bin/env python3
"""Tests for the adaptive Whisper sample window (calculate_smart_duration).

The rules under test, as implemented in match_whisper_to_transcript.py:

Part 1 (transcript-based; always captures from the video start so the
word-anchor matcher can pin the transcript's opening segments):
    schedule      = 9:00 AM for first speech in 8 AM–noon, 5:00 PM for ≥ 5 PM,
                    otherwise no schedule → DEFAULT_DURATION (600 s)
    est_speech    = PRE_ROLL (300) + (first_speech − schedule)
                    capped at chapter[1].seconds when that is earlier
    window        = AudioWindow(0, clamp(est_speech + MATCH_BUFFER (180),
                                         600, MAX_PART1_DURATION (1500)))

Part 2+ (chapter-based; chapter[0] is the video start and is ignored):
    chapter[1] > 60 s  → AudioWindow(chapter[1] − 60, 60 + 300)
    chapter[1] ≤ 60 s  → AudioWindow(0, max(600, chapter[1] + 120))
    no chapter[1]      → AudioWindow(0, 900)

Run: venv/bin/python tests/test_smart_duration.py  (also pytest-compatible)
"""

import json
import os
import sys
import tempfile

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


def _chapters(first_content_secs):
    """chapter[0] = video start, chapter[1] = first agenda-item marker."""
    return [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 1", "timestamp": "00:00:00", "seconds": first_content_secs},
    ]


def _window(video_id, part, first_ts="9:00:00AM", chapters=None,
            mapping_missing=False, transcript_missing=False):
    """Run calculate_smart_duration against temp files and return the window."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        if not mapping_missing:
            _write_json(mp, _make_mapping(video_id, part, chapters))
        if not transcript_missing:
            _write_json(tp, _make_transcript(first_ts))
        return calculate_smart_duration(mp, tp, video_id)


def _check(result, expected, label):
    assert result == expected, f"{label}: expected {expected}, got {result}"
    print(f"  PASS: {label} → start={result.start}, {result.duration}s")


# ──────────────────────────────────────────────
# Part 1 — on-schedule starts stay at the 600 s minimum
# ──────────────────────────────────────────────

def test_part1_no_chapters():
    """9:00 AM start: est_speech 300 + 180 = 480 → clamped up to 600."""
    _check(_window("VID1", 1), AudioWindow(0, 600), "Part 1, on schedule")


def test_part1_with_chapters():
    """Part 1 ignores chapters unless chapter[1] is earlier than the estimate."""
    _check(_window("VID1", 1, chapters=_chapters(300)), AudioWindow(0, 600),
           "Part 1, chapter at 300 s")


def test_part1_chapter_caps_estimate():
    """9:15:50 AM start estimates speech at 1250 s, but chapter[1] at 400 s
    says the first agenda item was already underway → cap at 400 + 180."""
    _check(_window("VID1", 1, "9:15:50AM", chapters=_chapters(400)),
           AudioWindow(0, 600), "Part 1, chapter caps a late estimate (580 → 600 floor)")
    _check(_window("VID1", 1, "9:15:50AM", chapters=_chapters(700)),
           AudioWindow(0, 880), "Part 1, chapter caps a late estimate (700 + 180)")


def test_evening_session_part1():
    """5:01 PM: 60 s delay → est 360 → 540 → clamped up to 600."""
    _check(_window("VID1", 1, "5:01:00PM"), AudioWindow(0, 600), "Evening Part 1 at 5:01 PM")


def test_afternoon_not_evening():
    """1:30 PM is outside both schedule windows → default 600 s."""
    _check(_window("VID1", 1, "1:30:00PM"), AudioWindow(0, 600), "Afternoon (1:30 PM), no schedule")


# ──────────────────────────────────────────────
# Part 1 — late starts grow the window, always from 0
# ──────────────────────────────────────────────

def test_part1_typical_morning():
    """9:06:03 AM: delay 363 → est 663 → 663 + 180 = 843."""
    _check(_window("VID1", 1, "9:06:03AM"), AudioWindow(0, 843), "Part 1 at 9:06:03 AM")


def test_part1_late_morning_start():
    """9:15:50 AM: delay 950 → est 1250 → 1250 + 180 = 1430."""
    _check(_window("VID1", 1, "9:15:50AM"), AudioWindow(0, 1430), "Part 1 at 9:15:50 AM")


def test_part1_evening_late_start():
    """5:20:06 PM: delay 1206 → est 1506 → 1686 → clamped to the 1500 s ceiling."""
    _check(_window("VID1", 1, "5:20:06PM"), AudioWindow(0, 1500), "Evening Part 1 at 5:20:06 PM")


def test_real_meeting_2656():
    """Meeting 2656 spoke at 9:15:50 AM — the capture must reach past the
    18 minutes of b-roll (window covers 1250 s estimate + buffer)."""
    result = _window("ABC123", 1, "9:15:50AM")
    _check(result, AudioWindow(0, 1430), "Real 2656 (9:15:50 AM)")
    assert result.start == 0, "Part 1 always captures from the video start"
    assert result.duration > 1250, "Window must reach the estimated first speech"


# ──────────────────────────────────────────────
# Part 2+ — centred on chapter[1]
# ──────────────────────────────────────────────

def test_part2_chapter_past_margin():
    """chapter[1] = 672 s → skip to 612, capture 60 s before + 300 s after."""
    _check(_window("VID2", 2, chapters=_chapters(672)), AudioWindow(612, 360),
           "Part 2, chapter at 672 s")


def test_part2_chapter_within_default():
    """chapter[1] = 300 s is still > 60 s margin → skip to 240, capture 360."""
    _check(_window("VID2", 2, chapters=_chapters(300)), AudioWindow(240, 360),
           "Part 2, chapter at 300 s")


def test_part2_chapter_too_early_for_margin():
    """chapter[1] = 45 s (≤ 60 s margin) → capture from 0, max(600, 45 + 120)."""
    _check(_window("VID2", 2, chapters=_chapters(45)), AudioWindow(0, 600),
           "Part 2, chapter at 45 s")


def test_part3_chapters_long_intro():
    """Part 3 uses the same rule: chapter[1] = 840 s → (780, 360)."""
    _check(_window("VID3", 3, chapters=_chapters(840)), AudioWindow(780, 360),
           "Part 3, chapter at 840 s")


def test_evening_session_part2_with_chapters():
    """Part 2+ ignores the transcript time of day: 5:30 PM, chapter 720 → (660, 360)."""
    _check(_window("VID2", 2, "5:30:00PM", chapters=_chapters(720)), AudioWindow(660, 360),
           "Evening Part 2, chapter at 720 s")


def test_real_meeting_2645_part2():
    """Meeting 2645 Part 2: chapter[1] at 672 s (actual speech ~630 s) → (612, 360)
    — the window opens 18 s before the speech."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 9: CRA25-18657", "timestamp": "00:11:12", "seconds": 672},
        {"title": "Item 11: CRA25-18681", "timestamp": "00:11:52", "seconds": 712},
    ]
    result = _window("oCSGYDZXHbk", 2, chapters=chapters)
    _check(result, AudioWindow(612, 360), "Real 2645 Part 2")
    assert result.start < 630 < result.start + result.duration, "window must cover 630 s speech"


def test_real_meeting_2637_part2():
    """Meeting 2637 Part 2: chapter[1] at 506 s → (446, 360)."""
    chapters = [
        {"title": "Start of Meeting", "timestamp": "00:00:00", "seconds": 0},
        {"title": "Item 66: CM25-16989", "timestamp": "00:08:26", "seconds": 506},
    ]
    _check(_window("JDkKcc-aFWY", 2, "9:06:53AM", chapters=chapters), AudioWindow(446, 360),
           "Real 2637 Part 2")


# ──────────────────────────────────────────────
# Part 2+ — no usable chapters
# ──────────────────────────────────────────────

def test_part2_no_chapters():
    _check(_window("VID2", 2), AudioWindow(0, 900), "Part 2, no chapters")


def test_part2_single_chapter_only():
    """Only the 'Start of Meeting' chapter → treated as no chapters."""
    _check(_window("VID2", 2, chapters=_chapters(0)[:1]), AudioWindow(0, 900),
           "Part 2, single chapter")


def test_evening_session_part2_no_chapters():
    _check(_window("VID2", 2, "6:30:00PM"), AudioWindow(0, 900), "Evening Part 2, no chapters")


# ──────────────────────────────────────────────
# Edge cases
# ──────────────────────────────────────────────

def test_missing_mapping_file():
    """Unreadable mapping → Part 1 defaults."""
    _check(_window("VID1", 1, mapping_missing=True), AudioWindow(0, 600), "Missing mapping file")


def test_video_id_not_in_mapping():
    """Unknown video id → Part 1 defaults."""
    with tempfile.TemporaryDirectory() as d:
        mp = os.path.join(d, "mapping.json")
        tp = os.path.join(d, "transcript.json")
        _write_json(mp, _make_mapping("OTHER_VID", 2))
        _write_json(tp, _make_transcript("9:00:00AM"))
        _check(calculate_smart_duration(mp, tp, "VID1"), AudioWindow(0, 600), "Video id not in mapping")


def test_missing_transcript_file():
    """Part 2 without a transcript still follows the chapter rule."""
    _check(_window("VID2", 2, transcript_missing=True), AudioWindow(0, 900), "Missing transcript, Part 2")


# ──────────────────────────────────────────────
# Runner (pytest collects the test_* functions directly)
# ──────────────────────────────────────────────

def main():
    tests = [fn for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)]
    passed = failed = 0
    for test in tests:
        print(f"\n{test.__name__}:")
        try:
            test()
            passed += 1
        except AssertionError as e:
            print(f"  FAIL: {e}")
            failed += 1
        except Exception as e:  # noqa: BLE001 — report and keep going
            print(f"  ERROR: {type(e).__name__}: {e}")
            failed += 1

    print(f"\n{'=' * 60}")
    print(f"Results: {passed}/{passed + failed} passed")
    if failed:
        print(f"  {failed} FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()

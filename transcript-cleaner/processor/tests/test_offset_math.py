#!/usr/bin/env python3
"""Offset matcher math: midnight wrap, anchor support rules, and the n-gram
fallback's early-segment preference (kept: audio checks showed it beats the median).

Fixtures are synthetic. Speech is modelled as contiguous: each sentence takes
0.4 s per word plus a short pause, and the "official" clerk timestamp is the
whole-second floor of each sentence's start (so anchors carry sub-second
jitter, like real clerk stamps). The Whisper side is that same speech placed
`true_offset` seconds into the video. The matcher must recover the offset.

Run: venv/bin/python tests/test_offset_math.py  (also pytest-compatible)
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.build.match_whisper_to_transcript import (  # noqa: E402
    SECONDS_PER_DAY,
    ANCHOR_TIGHT_PAIR_SPREAD,
    calculate_offset,
    calculate_offset_by_anchors,
    find_best_match,
    parse_timestamp_to_seconds,
    seconds_since,
    whisper_cache_path,
)

# Distinctive sentences (≥ 5 words, ≥ 3 of them 4+ letters) so each can anchor.
SENTENCES = [
    "Good morning everyone the Tampa City Council meeting will now come to order",
    "Councilman Viera would you please lead the invocation and pledge this morning",
    "The stormwater assessment ordinance for Seminole Heights neighborhood is before us",
    "Legal department has reviewed the proposed amendment regarding the Westshore overlay",
    "Motion carries unanimously and the Riverwalk extension contract is approved today",
    "Transportation staff will present the Bayshore Boulevard resurfacing schedule next",
    "Public comment is closed and the chairman recognizes the parks director",
    "Budget office reports the reserve balance exceeds the twenty percent policy floor",
]
SHORT = ["Yes.", "Thank you.", "Second.", "So moved."]

WORD_SECS = 0.4
PAUSE_SECS = 0.6


def _fmt(secs):
    """Seconds from midnight → clerk-style stamp like 12:00:05AM."""
    secs = int(secs) % SECONDS_PER_DAY
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h % 12 or 12}:{m:02d}:{s:02d}{'AM' if h < 12 else 'PM'}"


def _fixture(texts, baseline_ts, true_offset, clerk_delay=None, words=True):
    """Return (official_segments, whisper_segments).

    clerk_delay: {segment index: whole seconds} added to that segment's clerk
    stamp, simulating the clerk stamping late (positive) or early (negative).
    """
    base = parse_timestamp_to_seconds(baseline_ts)
    official, whisper = [], []
    t = 0.0
    for i, text in enumerate(texts):
        toks = text.split()
        stamp = base + int(t) + (clerk_delay or {}).get(i, 0)
        official.append({"timestamp": _fmt(stamp), "speaker": "X", "text": text})
        t0 = true_offset + t
        entry = {"start": t0, "end": t0 + WORD_SECS * len(toks), "text": text,
                 "no_speech_prob": 0.0}
        if words:
            entry["words"] = [{"word": w, "start": t0 + WORD_SECS * k,
                               "end": t0 + WORD_SECS * k + 0.3}
                              for k, w in enumerate(toks)]
        whisper.append(entry)
        t += WORD_SECS * len(toks) + PAUSE_SECS
    return official, whisper


def _anchors(texts, baseline_ts, true_offset, clerk_delay=None):
    official, wh = _fixture(texts, baseline_ts, true_offset, clerk_delay)
    return calculate_offset_by_anchors(wh, official, parse_timestamp_to_seconds(baseline_ts))


def _check(cond, label):
    assert cond, label
    print(f"  PASS: {label}")


# ──────────────────────────────────────────────
# Time math
# ──────────────────────────────────────────────

def test_seconds_since_same_day_and_wrap():
    pm = parse_timestamp_to_seconds("5:06:25PM")
    am = parse_timestamp_to_seconds("3:04:56AM")
    _check(seconds_since(pm, pm + 90) == 90, "same day: +90")
    _check(seconds_since(pm, pm - 5) == -5, "small negative kept: -5")
    _check(seconds_since(pm, am) == am - pm + SECONDS_PER_DAY,
           "3:04 AM after a 5:06 PM baseline wraps (+86400)")


def test_parse_timestamp_tolerates_inner_space():
    _check(parse_timestamp_to_seconds("9:15:50 AM") == 9 * 3600 + 15 * 60 + 50, "'9:15:50 AM' parses")
    _check(parse_timestamp_to_seconds("12:32:11AM") == 32 * 60 + 11, "12:32:11AM → 1931")
    _check(_fmt(parse_timestamp_to_seconds("12:32:11AM")) == "12:32:11AM", "fixture formatter round-trips")


def test_whisper_cache_path_labels():
    p = whisper_cache_path("VID", "small", 0, 300)
    _check(p.name == "VID_small.json", "default window has no label")
    _check(whisper_cache_path("VID", "small", 0, 600).name == "VID_small_10min.json", "10min label")
    _check(whisper_cache_path("VID", "small", 612, 360).name == "VID_small_skip612s_360s.json",
           "skip label")
    _check(p.is_absolute(), "cache path is absolute (not CWD-relative)")


# ──────────────────────────────────────────────
# Word-anchor pass
# ──────────────────────────────────────────────

def test_four_anchors_prefer_baseline_segment():
    off = _anchors(SENTENCES[:4], "9:00:00AM", 100.0, clerk_delay={1: 1, 2: -1, 3: 2})
    _check(off is not None and abs(off - 100.0) < 0.01,
           f"4 anchors → baseline segment's offset 100.0 (got {off})")


def test_two_tight_anchors_accepted():
    # Only segments 1 and 2 can anchor; segment 0 is too short.
    off = _anchors([SHORT[0], SENTENCES[1], SENTENCES[2]], "9:00:00AM", 100.0, clerk_delay={2: 1})
    _check(off is not None and 98.5 <= off <= 101.0,
           f"2 anchors within {ANCHOR_TIGHT_PAIR_SPREAD}s → accepted (got {off})")


def test_two_loose_anchors_rejected():
    off = _anchors([SHORT[0], SENTENCES[1], SENTENCES[2]], "9:00:00AM", 100.0, clerk_delay={2: 5})
    _check(off is None, "2 anchors 5 s apart → inconclusive")


def test_single_anchor_rejected():
    off = _anchors([SHORT[0], SHORT[1], SENTENCES[2]], "9:00:00AM", 100.0)
    _check(off is None, "1 anchor → inconclusive")


def test_anchor_pass_across_midnight():
    # Baseline 11:59:59 PM on an unanchorable "Yes."; every anchorable
    # sentence is stamped 12:00:xxAM, i.e. 86,399 s *before* the baseline by
    # naive subtraction. Without the wrap the anchors agree with each other at
    # an offset near 86,500 s and the matcher happily returns it.
    official, wh = _fixture([SHORT[0]] + SENTENCES[:3], "11:59:59PM", 100.0)
    assert all(seg["timestamp"].endswith("AM") for seg in official[1:]), official
    off = calculate_offset_by_anchors(wh, official, parse_timestamp_to_seconds("11:59:59PM"))
    _check(off is not None and 99.0 <= off <= 100.5,
           f"post-midnight anchors measure from the pre-midnight baseline (got {off})")


# ──────────────────────────────────────────────
# calculate_offset with a transcript_start_time after midnight
# ──────────────────────────────────────────────

def test_calculate_offset_part_starting_after_midnight():
    evening, _ = _fixture(SENTENCES[:4], "7:00:00PM", 0.0)
    late, wh = _fixture(SENTENCES[4:8], "12:01:00AM", 60.0, clerk_delay={1: 1, 2: -1})
    with tempfile.TemporaryDirectory() as d:
        wf = os.path.join(d, "whisper.json")
        tf = os.path.join(d, "transcript.json")
        with open(wf, "w") as f:
            json.dump({"segments": wh}, f)
        with open(tf, "w") as f:
            json.dump({"segments": evening + late}, f)
        off = calculate_offset(wf, tf, transcript_start_time="12:01:00AM")
    _check(off is not None and abs(off - 60.0) < 0.01,
           f"part beginning at 12:01 AM matches its own segments (got {off})")


# ──────────────────────────────────────────────
# n-gram fallback (no word timestamps)
# ──────────────────────────────────────────────

def test_ngram_fallback_prefers_direct_segment_zero_match():
    """Without word timestamps the n-gram path clusters interpolated offsets;
    a Whisper candidate that matches official segment 0 gives the offset with
    no interpolation and is preferred when it agrees with the cluster."""
    official, wh = _fixture(SENTENCES[:6], "9:00:00AM", 100.0, words=False)
    best = find_best_match(wh, official, first_seconds=parse_timestamp_to_seconds("9:00:00AM"))
    _check(best is not None, "n-gram path finds a match")
    _check(best.get("early_match") is True and best["official_index"] == 0,
           "direct segment-0 match preferred")
    _check(abs(best["implied_offset"] - 100.0) < 0.01,
           f"direct offset is exact (got {best['implied_offset']:.1f})")


def test_ngram_fallback_cluster_median_without_segment_zero():
    """When Whisper never catches the opening line, the cluster median stands."""
    official, wh = _fixture(SENTENCES[:6], "9:00:00AM", 100.0, words=False)
    best = find_best_match(wh[2:], official, first_seconds=parse_timestamp_to_seconds("9:00:00AM"))
    _check(best is not None and best.get("cluster_median") is True, "cluster median used")
    _check(99.5 <= best["implied_offset"] <= 101.5,
           f"median within a second of the truth (got {best['implied_offset']:.1f})")


# ──────────────────────────────────────────────
# Runner (pytest collects the test_* functions directly)
# ──────────────────────────────────────────────

def main():
    import logging
    logging.disable(logging.CRITICAL)
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
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR: {type(e).__name__}: {e}")
            failed += 1
    print(f"\n{'=' * 60}")
    print(f"Results: {passed}/{passed + failed} passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

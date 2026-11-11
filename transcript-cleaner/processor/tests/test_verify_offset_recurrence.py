"""scripts/verify-offset.py must not anchor on a sentence the transcript repeats.

11/5/26, transcript 2715 part 2: the gate sampled the clerk's "Second hearing
and adoption will be held on ..." line, which she reads after every first
reading. The audio match landed on the copy one item earlier and the gate
reported a -63s drift on an offset that was correct. The boilerplate regex
cannot list every such sentence, so the anchor is checked against the rest of
the transcript instead.
"""
import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VERIFY_OFFSET = REPO_ROOT / "scripts" / "verify-offset.py"

CLERK = ("Second hearing and adoption will be held on November 19, 2026 at 11 a.m. "
         "in City Council Chambers, 315 East Kennedy Boulevard, third floor, Tampa, "
         "Florida 33602.")
READING = ("File e 2026-8, chapter {n}, ordinance being presented for first reading "
           "consideration, an ordinance relating to charter section {n} point zero {n}, "
           "removing an obsolete reference and providing an effective date for the change.")
DISTINCT = ("I knew the Chief Building inspector back in 1975 and I have to make a "
            "confession that the office was on the fourth floor next to the old "
            "print shop where the water bills went out.")


def _load_verify_offset():
    spec = importlib.util.spec_from_file_location("verify_offset", VERIFY_OFFSET)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _seg(secs, text, speaker="The clerk"):
    return {"ts": "", "secs": secs, "text": text, "speaker": speaker}


def _first_reading_run():
    """Three first readings, the clerk's line after each, one distinctive remark."""
    return [
        _seg(100, READING.format(n=9), "Charlie Miranda"),
        _seg(130, CLERK),
        _seg(160, READING.format(n=10), "Bill Carlson"),
        _seg(190, CLERK),
        _seg(220, DISTINCT, "Charlie Miranda"),
        _seg(250, CLERK),
    ]


def test_repeated_sentence_is_flagged_and_passes_the_old_filter():
    mod = _load_verify_offset()
    segs = _first_reading_run()
    clerk = segs[3]

    assert mod.is_generic(clerk) is False, "the regex filter alone lets this line through"
    assert mod.anchor_recurs(clerk, segs) is True
    assert mod.anchor_recurs(segs[4], segs) is False


def test_near_identical_readings_count_as_repeats():
    mod = _load_verify_offset()
    segs = _first_reading_run()

    # Same sentence with a different chapter number: still ambiguous in audio.
    assert mod.anchor_recurs(segs[0], segs) is True


def test_pick_candidate_skips_the_repeat_at_the_midpoint():
    mod = _load_verify_offset()
    segs = _first_reading_run()

    # frac 0.5 of six segments targets index 3, the clerk's middle copy.
    idx, seg = mod.pick_candidate(segs, 0.5)
    assert seg["text"] == DISTINCT
    assert idx == 4


def test_pick_at_skips_the_repeat_nearest_the_requested_time():
    mod = _load_verify_offset()
    segs = _first_reading_run()

    idx, seg = mod.pick_at(segs, 190)
    assert seg["text"] == DISTINCT


def test_repeat_in_another_part_still_disqualifies():
    mod = _load_verify_offset()
    segs = _first_reading_run()
    morning = _seg(10, "Before we begin, " + CLERK)
    part_two = segs[3:]            # one clerk copy left in this part, plus the remark

    idx, seg = mod.pick_candidate(part_two, 0.0, segments=[morning] + segs)
    assert seg["text"] == DISTINCT


def test_nothing_distinctive_returns_none():
    mod = _load_verify_offset()
    segs = [_seg(100, CLERK), _seg(160, CLERK)]

    assert mod.pick_candidate(segs, 0.5) is None
    assert mod.pick_at(segs, 100) is None

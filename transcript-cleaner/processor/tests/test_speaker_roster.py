#!/usr/bin/env python3
"""Tests for the speaker-label roster (data/roster_entities.json).

Verifies that members missing from the agenda-derived database are now
capitalized from the roster, and that common-word surnames stay safe.

Run from the processor/ directory:
    python tests/test_speaker_roster.py
"""

from src.capitalize_transcript import TranscriptCapitalizer

cap = TranscriptCapitalizer(use_gliner=False)

tests = {
    # Members absent from the agenda DB, now covered by the roster.
    # (This was the "Former Council Member gudes" bug.)
    "A REQUEST FROM FORMER COUNCIL MEMBER GUDES": "A request from former council member Gudes",
    "BOARD MEMBER VIERA ASKED A QUESTION": "Board member Viera asked a question",
    "I AGREE WITH HURTAK ON THIS": "I agree with Hurtak on this",
    "COUNCIL MEMBER CITRO MADE THE MOTION": "Council member Citro made the motion",

    # Full names with intercaps casing recovered from speaker labels.
    "CEDRIC MCCRAY GAVE THE REPORT": "Cedric McCray gave the report",
    "WE HEARD FROM LACHONE DOCK": "We heard from LaChone Dock",

    # Common-word surnames: capitalized in full-name context...
    "NAYA YOUNG SECONDED": "Naya Young seconded",
    # ...but NOT when the bare word is used as a common adjective.
    "THE YOUNG MAN SPOKE": "The young man spoke",
    "WE DOCK THE BOAT": "We dock the boat",

    # name_allowlist: "miranda" is a dictionary word but a sitting member whose
    # common-word sense is rare, so it capitalizes even as a bare surname.
    "I AGREE WITH MIRANDA": "I agree with Miranda",
    # "young" stays OFF the allowlist — the everyday adjective is too common.
    "WE SUPPORT YOUNG FAMILIES": "We support young families",
}

passed = failed = 0
for input_text, expected in tests.items():
    result = cap.capitalize_text(input_text)
    if result == expected:
        passed += 1
        print(f"  PASS: {result}")
    else:
        failed += 1
        print(f"  FAIL: {result}")
        print(f"    expected: {expected}")

print(f"\n{passed}/{passed + failed} passed")
raise SystemExit(1 if failed else 0)

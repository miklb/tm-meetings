#!/usr/bin/env python3
"""Regression tests for the 2827 (CRA meeting) capitalizer bugs.

Covers acronym plurals, single-word council surnames, and ambiguous month
words. GLiNER is disabled so these run fast and deterministically.

Run from the processor/ directory:
    python tests/test_capitalizer_bugfixes.py
"""

from src.capitalize_transcript import TranscriptCapitalizer

cap = TranscriptCapitalizer(use_gliner=False)

tests = {
    # --- Acronym plurals (was "Cras"/"cras", "Cacs") ---
    "BOTH CRAS SUNSET IN 2034": "Both CRAs sunset in 2034",
    "WE WORK WITH THE CACS": "We work with the CACs",
    "AFFORDABLE HOUSING IN YBOR CITY CRAS": "Affordable housing in Ybor City CRAs",
    # singular acronym still works ("CRA Board" is a known multi-word entity)
    "THE CRA BOARD MET": "The CRA Board met",
    # common words must NOT be mangled by the plural rule
    "IT IS AS GOOD AS US": "It is as good as us",

    # --- Single-word surnames (was lowercase "clendenin") ---
    "BOARD MEMBER CLENDENIN": "Board member Clendenin",
    "A SECOND FROM BOARD MEMBER MANISCALCO": "A second from board member Maniscalco",
    # role words harvested from "Chair Clendenin" must stay lowercase mid-sentence
    "WE HAVE A MOTION FROM THE BOARD": "We have a motion from the board",

    # --- Ambiguous months (was "There May be", "March forward") ---
    "THERE MAY BE OPPORTUNITIES": "There may be opportunities",
    "YOU MAY SEE SOME FACES": "You may see some faces",
    # genuine date context should still capitalize
    "THE MEETING WAS IN MAY 2026": "The meeting was in May 2026",
    "ON MARCH 14 WE VOTED": "On March 14 we voted",
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

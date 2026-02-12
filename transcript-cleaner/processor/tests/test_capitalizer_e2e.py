#!/usr/bin/env python3
"""Quick end-to-end test of the capitalizer with config-loaded data."""

from src.capitalize_transcript import TranscriptCapitalizer

cap = TranscriptCapitalizer(use_gliner=False)
print(f"\nAcronyms loaded: {len(cap.acronyms)}")
print(f"Neighborhoods loaded: {len(cap.neighborhoods)}")
print(f"Street suffixes loaded: {len(cap.street_suffixes)}")

tests = {
    "USF IS A GREAT UNIVERSITY": "USF is a great university",
    "CCTV CAMERAS WERE INSTALLED": "CCTV cameras were installed",
    "FDOT APPROVED THE PROJECT": "FDOT approved the project",
    "THE CDBG GRANT WAS APPROVED": "The CDBG grant was approved",
    "HART BUS ROUTES WERE CHANGED": "HART bus routes were changed",
    "NORTH FRANKLIN STREET IS CLOSED": "North Franklin Street is closed",
    "SEMINOLE HEIGHTS RESIDENTS SPOKE": "Seminole Heights residents spoke",
    "JOHNSON-VELEZ SECONDED THE MOTION": "Johnson-Velez seconded the motion",
    "MANISCALCO-MIRANDA CALLED THE MEETING TO ORDER": "Maniscalco-Miranda called the meeting to order",
    "THE FDOT PROJECT ON EAST KENNEDY BOULEVARD WAS DISCUSSED": "The FDOT project on East Kennedy Boulevard was discussed",
}

print()
passed = failed = 0
for input_text, expected in tests.items():
    result = cap.capitalize_text(input_text)
    ok = "PASS" if result == expected else "FAIL"
    if result == expected:
        passed += 1
    else:
        failed += 1
    print(f"  {ok}: {result}")
    if result != expected:
        print(f"    expected: {expected}")

print(f"\n{passed}/{passed + failed} passed")

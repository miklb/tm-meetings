#!/usr/bin/env python3
"""Quick end-to-end test of the capitalizer with config-loaded data."""

from src.capitalize_transcript import TranscriptCapitalizer

print("=== Running Heuristic Capitalizer Tests (use_gliner=False) ===")
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
    
    # Contractions
    "WE DON'T WANT TO GO": "We don't want to go",
    "IT'S A GREAT DAY": "It's a great day",
    "THEY WOULDN'T AGREE TO THE TERMS": "They wouldn't agree to the terms",
    "I'LL BE THERE": "I'll be there",
    
    # Possessives
    "THE CFO'S OFFICE REPORTED": "The CFO's office reported",
    "THE CLERK'S OFFICE IS OPEN": "The clerk's office is open",
    "WE DISCUSS BOCC'S NEW DECISION": "We discuss BOCC's new decision",
    "THE TDT'S COLLECTION INCREASED": "The TDT's collection increased",
    "HILLSBOROUGH'S PARKS ARE BEAUTIFUL": "Hillsborough's parks are beautiful",
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

# Test with GLiNER enabled to verify zero-shot learning labels (law, document, facility)
print("\n=== Running GLiNER Zero-Shot Tests (use_gliner=True) ===")
cap_gliner = TranscriptCapitalizer(use_gliner=True)

gliner_tests = {
    # The "law"/"document"/"facility" GLiNER labels were removed because they
    # title-cased generic phrases ("Laws in Place", "Required Documents",
    # "Beautiful Park"). Named acts are no longer auto-capitalized by GLiNER —
    # add them to data/standard_entities.json for reliable, false-positive-free
    # capitalization.
    "THE BROWNFIELDS REDEVELOPMENT ACT WAS PASSED": "The brownfields redevelopment act was passed",
    # Document name capitalization with lowercase prepositions/conjunctions (e.g. on, of)
    "THE STAFF REPORT ON ROYAL STREET BROWNFIELD AREA DESIGNATION WAS READ": "The Staff report on Royal Street Brownfield Area designation was read",
    # Facility capitalization
    "WE MET AT THE TAMPA CONVENTION CENTER": "We met at The Tampa Convention Center",
    "THE EVENT WAS AT CURTIS HIXON PARK": "The event was at Curtis Hixon Park",
}

print()
gliner_passed = gliner_failed = 0
for input_text, expected in gliner_tests.items():
    result = cap_gliner.capitalize_text(input_text)
    ok = "PASS" if result == expected else "FAIL"
    if result == expected:
        gliner_passed += 1
    else:
        gliner_failed += 1
    print(f"  {ok}: {result}")
    if result != expected:
        print(f"    expected: {expected}")

print(f"\n{gliner_passed}/{gliner_passed + gliner_failed} passed")

import sys
if failed > 0 or gliner_failed > 0:
    sys.exit(1)
else:
    sys.exit(0)


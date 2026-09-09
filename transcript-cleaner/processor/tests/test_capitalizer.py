#!/usr/bin/env python3
"""Capitalizer rules, pinned with the cases that have gone wrong in real
transcripts. GLiNER is off so the run is fast and deterministic; every
expectation below comes from the entity lists that ship in data/ (speaker
roster, agenda entities, config) plus the rule chain in
src/capitalize_transcript.py.

Run: venv/bin/python -m pytest tests/test_capitalizer.py -q
     (or venv/bin/python tests/test_capitalizer.py)
"""

import io
import os
import sys
import contextlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.capitalize_transcript import TranscriptCapitalizer  # noqa: E402

_cap = None


def cap():
    global _cap
    if _cap is None:
        with contextlib.redirect_stdout(io.StringIO()):
            _cap = TranscriptCapitalizer(use_gliner=False)
    return _cap


def check(cases):
    failures = []
    for raw, expected in cases.items():
        got = cap().capitalize_text(raw)
        if got == expected:
            print(f"  PASS: {got}")
        else:
            failures.append(f"{raw!r}\n      got:      {got!r}\n      expected: {expected!r}")
    assert not failures, "\n".join(failures)


# ──────────────────────────────────────────────
# The eight cases from the 2026-09-03 review
# ──────────────────────────────────────────────

def test_review_cases():
    check({
        "YES I'LL BE THERE AND I'M SURE": "Yes I'll be there and I'm sure",
        "IT COSTS $1.5 MILLION": "It costs $1.5 million",
        "GOOD MORNING, MR. CHAIRMAN": "Good morning, Mr. Chairman",
        "WALK ACROSS THE STREET": "Walk across the street",
        "THIS MAY BE A PROBLEM": "This may be a problem",
        "ITS OWN BUDGET": "Its own budget",
        "MCCRAY, YOU HAVE THE FLOOR": "McCray, you have the floor",
        "MASS TRANSIT IS IN BLACK AND WHITE": "Mass transit is in black and white",
    })


# ──────────────────────────────────────────────
# Sentence boundaries and fixed forms
# ──────────────────────────────────────────────

def test_sentence_boundaries():
    check({
        "WE MET MS. BENNETT. SHE SPOKE FIRST": "We met Ms. Bennett. She spoke first",
        "A $1.9 BILLION COMPANY AND YET": "A $1.9 billion company and yet",
        "WE START AT 9 A.M. TODAY": "We start at 9 a.m. today",
        "IS THAT RIGHT? YES. THANK YOU": "Is that right? Yes. Thank you",
        "I SAID \"NO.\" THEN WE LEFT": "I said \"no.\" Then we left",
    })


def test_pronoun_i_and_contractions():
    check({
        "I THINK I'D LIKE THAT AND I'VE SAID SO": "I think I'd like that and I've said so",
        "IT'S A GREAT DAY": "It's a great day",
        "WE DON'T WANT TO GO": "We don't want to go",
        "THEY WOULDN'T AGREE TO THE TERMS": "They wouldn't agree to the terms",
    })


def test_titles_capitalize_the_following_word():
    check({
        "THANK YOU, MR. MAYOR": "Thank you, Mr. Mayor",
        "MS. BENNETT SAID SO": "Ms. Bennett said so",
        "MR. MAYOR THANK YOU": "Mr. Mayor thank you",
        # "ann" is an ordinary word in the system dictionary, so a middle
        # name the roster does not know stays lowercase — a miss, by design.
        "WE WILL GO TO MS. CARROLL ANN BENNETT": "We will go to Ms. Carroll ann Bennett",
        "DR. SMITH IS HERE": "Dr. Smith is here",
    })


# ──────────────────────────────────────────────
# Acronyms
# ──────────────────────────────────────────────

def test_acronyms_and_plurals():
    check({
        "USF IS A GREAT UNIVERSITY": "USF is a great university",
        "CCTV CAMERAS WERE INSTALLED": "CCTV cameras were installed",
        "THE CDBG GRANT WAS APPROVED": "The CDBG grant was approved",
        "BOTH CRAS SUNSET IN 2034": "Both CRAs sunset in 2034",
        "WE WORK WITH THE CACS": "We work with the CACs",
        "THE CRA BOARD MET": "The CRA Board met",
        "CRA BOARD MET TODAY": "CRA Board met today",
        "IT IS AS GOOD AS US": "It is as good as us",
        "THE IT DEPARTMENT AND THE US GOVERNMENT": "The IT department and the US government",
        "THE CFO'S OFFICE REPORTED": "The CFO's office reported",
        "WE DISCUSS BOCC'S NEW DECISION": "We discuss BOCC's new decision",
    })


# ──────────────────────────────────────────────
# Names: roster, agenda entities, common-word surnames
# ──────────────────────────────────────────────

def test_roster_names_anywhere_in_the_sentence():
    check({
        "ALAN CLENDENIN": "Alan Clendenin",
        "BOARD MEMBER CLENDENIN": "Board member Clendenin",
        "A SECOND FROM BOARD MEMBER MANISCALCO": "A second from board member Maniscalco",
        "CLENDENIN, YOU HAVE THE FLOOR": "Clendenin, you have the floor",
        "JOHNSON-VELEZ SECONDED THE MOTION": "Johnson-Velez seconded the motion",
        "MANISCALCO-MIRANDA CALLED THE MEETING TO ORDER": "Maniscalco-Miranda called the meeting to order",
    })


def test_common_word_surnames_need_a_title():
    check({
        "COUNCILWOMAN YOUNG SAID": "Councilwoman Young said",
        "I SAW THE YOUNG LADY CRYING": "I saw the young lady crying",
        "WE HEARD FROM A YOUNG MAN TODAY": "We heard from a young man today",
        "WE HAVE A MOTION FROM THE BOARD": "We have a motion from the board",
    })


# ──────────────────────────────────────────────
# Months
# ──────────────────────────────────────────────

def test_ambiguous_months():
    check({
        "THERE MAY BE OPPORTUNITIES": "There may be opportunities",
        "YOU MAY SEE SOME FACES": "You may see some faces",
        "YOU MAY RECALL THAT": "You may recall that",
        "THE MEETING WAS IN MAY 2026": "The meeting was in May 2026",
        "IN MAY WE VOTED": "In May we voted",
        "ON MARCH 14 WE VOTED": "On March 14 we voted",
        "WE WILL MARCH FORWARD": "We will march forward",
        "BACK IN MAY OF 2025": "Back in May of 2025",
        "AUGUST 27 IS THE DATE": "August 27 is the date",
    })


# ──────────────────────────────────────────────
# Streets, neighborhoods, organizations, generic phrases
# ──────────────────────────────────────────────

def test_streets_need_a_number_direction_or_known_name():
    check({
        "NORTH FRANKLIN STREET IS CLOSED": "North Franklin Street is closed",
        "1505 NORTH FLORIDA AVENUE": "1505 North Florida Avenue",
        "AT 2901 N. ALBANY AVENUE": "At 2901 N. Albany Avenue",
        "THE PROJECT ON EAST KENNEDY BOULEVARD": "The project on East Kennedy Boulevard",
        "BAYSHORE BOULEVARD WAS FLOODED": "Bayshore Boulevard was flooded",
        "DOWN THE STREET FROM THE MARKET": "Down the street from the market",
        "IT'S A ONE WAY STREET": "It's a one way street",
    })


def test_neighborhoods_and_organizations():
    check({
        "SEMINOLE HEIGHTS RESIDENTS SPOKE": "Seminole Heights residents spoke",
        "AFFORDABLE HOUSING IN YBOR CITY CRAS": "Affordable housing in Ybor City CRAs",
        "WE MET AT THE TAMPA CONVENTION CENTER": "We met at the Tampa Convention Center",
        "HILLSBOROUGH'S PARKS ARE BEAUTIFUL": "Hillsborough's parks are beautiful",
    })


def test_generic_phrases_stay_lowercase():
    check({
        "THE BROWNFIELDS REDEVELOPMENT ACT WAS PASSED": "The brownfields redevelopment act was passed",
        "SMALL BUSINESS OWNERS SPOKE": "Small business owners spoke",
        "THE STAFF REPORT WAS READ": "The staff report was read",
        "THEY BEGIN TO BELIEVE IT": "They begin to believe it",
        "THANK GOD FOR THE GRANT": "Thank god for the grant",
    })


# ──────────────────────────────────────────────
# Rules added after the first corpus report
# ──────────────────────────────────────────────

def test_role_titles_before_a_known_name():
    check({
        "COUNCILMAN CITRO AND COUNCILWOMAN HURTAK": "Councilman Citro and Councilwoman Hurtak",
        "CHAIRMAN REDDICK STOOD": "Chairman Reddick stood",
        "THE COUNCIL MEMBER SAID": "The council member said",
        "THE CHAIRMAN SAID": "The chairman said",
    })


def test_miss_is_a_title_only_before_a_name():
    check({
        "I CANNOT MISS IT. MISS BURTON IS HERE": "I cannot miss it. Miss Burton is here",
    })


def test_mc_names_keep_intercaps():
    check({
        "MS. MCCASKILL PROVIDED IT": "Ms. McCaskill provided it",
        "MCCALLISTER ALSO NOTES THAT": "McCallister also notes that",
    })


def test_street_rule_cases_only_the_listed_name():
    check({
        "LAND USE CATEGORY ALONG FLORIDA AVENUE": "Land use category along Florida Avenue",
        "I CAN TELL YOU RIGHT NOW THAT YUKON STREET IS ONE": "I can tell you right now that Yukon Street is one",
        "SHOULD FEEL THE SAME WAY ABOUT EVERYBODY": "Should feel the same way about everybody",
        "A $1 MILLION PLACE HOLDER": "A $1 million place holder",
        "NOT ONLY BAYSHORE BOULEVARD BUT HILLSBOROUGH": "Not only Bayshore Boulevard but Hillsborough",
    })


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
            print(f"  FAIL:\n{e}")
            failed += 1
    print(f"\n{'=' * 60}\nResults: {passed}/{passed + failed} passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

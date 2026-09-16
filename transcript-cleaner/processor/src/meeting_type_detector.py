"""
Meeting Type Detector

Detects meeting type from transcript data to enable automatic YouTube video matching.

The detector checks multiple signals in priority order:
0. The clerk's own meeting name from the agenda scrape on the transcript's
   DATE (agenda-scraper/data/meeting_*_<YYYY-MM-DD>.json → meetingName, e.g.
   "CRA Special Call") — authoritative when present; absent on pre-2026-08
   scrapes. Transcript pkeys and OnBase meeting ids are different id spaces,
   so the join is by date, and by scheduled time when a date has several
   meetings (CRA 09:00 + Evening 17:01).
1. meeting_title field (e.g., "TAMPA CITY COUNCIL WORKSHOPS")
2. meeting_date_time field (e.g., contains "5:01 P.M." for evening)
3. First 5 transcript segments text (e.g., "WELCOME TO THE CRA MEETING")
4. meetings_metadata.json lookup

Returns a MeetingType with both a canonical label and the YouTube search term
needed by youtube_fetcher.py's title-matching filter.
"""

import json
import re
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class MeetingType:
    """Detected meeting type with YouTube search term."""

    label: str  # Canonical label: "CRA", "City Council", "Workshop", "Evening", "Special"
    youtube_search_term: str  # String that appears in YouTube video titles

    def __str__(self) -> str:
        return self.label


# Known meeting types with their detection patterns and YouTube title strings.
# Order matters — first match wins, so more specific patterns come first.
MEETING_TYPE_RULES = [
    {
        "label": "CRA",
        "youtube_search_term": "Community Redevelopment",
        "title_patterns": [
            r"CRA\b",
            r"COMMUNITY\s+REDEVELOPMENT",
            r"REDEVELOPMENT\s+AGENCY",
        ],
        "text_patterns": [
            r"CRA\s+MEETING",
            r"COMMUNITY\s+REDEVELOPMENT",
            r"REDEVELOPMENT\s+AGENCY",
        ],
    },
    {
        "label": "Workshop",
        "youtube_search_term": "City Council",
        "title_patterns": [r"WORKSHOP"],
        "text_patterns": [r"WORKSHOP"],
    },
    {
        "label": "Evening",
        "youtube_search_term": "City Council",
        "title_patterns": [r"EVENING"],
        "text_patterns": [r"EVENING\s+SESSION", r"EVENING\s+MEETING"],
        # Also detect by scheduled time — evening meetings start at 5:01 PM
        "time_pattern": r"5:\d{2}\s*P\.?M",
    },
    {
        "label": "Special",
        "youtube_search_term": "City Council",
        "title_patterns": [r"SPECIAL"],
        "text_patterns": [r"SPECIAL\s+(?:MEETING|SESSION|DISCUSSION)"],
    },
    {
        "label": "City Council",
        "youtube_search_term": "City Council",
        "title_patterns": [r"CITY\s+COUNCIL", r"COUNCIL"],
        "text_patterns": [r"CITY\s+COUNCIL", r"COUNCIL\s+MEETING"],
    },
]

# Fallback search terms for older video titles that use abbreviations
# These are tried if the primary youtube_search_term finds no results
LEGACY_SEARCH_TERMS = {
    "City Council": ["TCC"],
    "CRA": ["TCC", "CRA"],
    "Workshop": ["TCC", "CHARTER WORKSHOP"],
    "Evening": ["TCC"],
}

# Map the inconsistent meetingType values from meetings_metadata.json / the
# agenda-scraper JSON. Covers both the scraper's 5-value enum (regular,
# evening, cra, workshop, special) and the raw OnBase type names older
# scrapes stored verbatim.
METADATA_TYPE_MAP = {
    "regular": "City Council",
    "council regular": "City Council",
    "special": "Special",
    "council special": "Special",
    "cra": "CRA",
    "cra regular": "CRA",
    "cra special": "CRA",
    "council evening": "Evening",
    "evening": "Evening",
    "workshop": "Workshop",
    "council workshop": "Workshop",
    "council calendar": "Workshop",
}

# agenda-scraper/data relative to this file (src → processor → transcript-cleaner → repo)
DEFAULT_AGENDA_DIR = Path(__file__).resolve().parents[3] / "agenda-scraper" / "data"
# processor/data/meetings_metadata.json, independent of the working directory
DEFAULT_METADATA_PATH = Path(__file__).resolve().parents[1] / "data" / "meetings_metadata.json"


def detect_meeting_type(
    transcript_path: Optional[str] = None,
    transcript_data: Optional[dict] = None,
    meeting_id: Optional[int] = None,
    metadata_path: str = str(DEFAULT_METADATA_PATH),
    agenda_dir: Optional[Path] = None,
) -> MeetingType:
    """
    Detect meeting type from the agenda scrape and transcript data.

    Checks multiple signals in priority order:
    0. Clerk's meeting name from the agenda-scraper JSON on the transcript's date
    1. meeting_title field
    2. meeting_date_time field (time-of-day hints)
    3. First 5 segment texts
    4. meetings_metadata.json lookup by date
    5. Falls back to "City Council"

    Args:
        transcript_path: Path to transcript JSON file (raw or processed).
        transcript_data: Already-loaded transcript dict (avoids re-reading file).
        meeting_id: Transcript pkey. Accepted for callers, not used for any
            lookup — agenda scrapes and meetings_metadata.json are keyed by
            OnBase meeting id, a different id space; both are joined by date.
        metadata_path: Path to meetings_metadata.json.
        agenda_dir: Directory of agenda-scraper meeting_<id>_<date>.json files
            (defaults to the repo's agenda-scraper/data).

    Returns:
        MeetingType with label and youtube_search_term.
    """
    if transcript_data is None and transcript_path is not None:
        path = Path(transcript_path)
        if path.exists():
            with open(path, "r") as f:
                transcript_data = json.load(f)
        else:
            logger.warning(f"Transcript file not found: {transcript_path}")

    # Signal 0: the clerk's own name for the meeting, from the agenda scrape
    # on this transcript's date. This is what the meeting *is*; the transcript
    # signals below are inferences from how it was transcribed.
    # When the date's agenda scrape identifies the meeting unambiguously, the
    # clerk's name is final: the transcript title/segments are inferences
    # ("TAMPA CITY COUNCIL AND CRA" on a combined day says CRA; the clerk's
    # 9:00 record says "City Council Regular"). One refinement: a generic
    # "City Council ..." name at a 5 PM clock is the Evening session for the
    # video tooling ("City Council Budget Public Hearing", 5:01 P.M.).
    date, minutes = _transcript_when(transcript_data, transcript_path)
    agenda_detected = _lookup_agenda_by_date(date, minutes, agenda_dir or DEFAULT_AGENDA_DIR)
    if agenda_detected:
        header = (transcript_data or {}).get("meeting_date_time") or ""
        if agenda_detected.label == "City Council" and _evening_by_clock(header):
            agenda_detected = _rule_type("Evening")
        logger.info(
            f"Detected meeting type '{agenda_detected.label}' from agenda scrape meetingName ({date})"
        )
        return agenda_detected

    if transcript_data is not None:
        title = transcript_data.get("meeting_title") or ""
        date_time = transcript_data.get("meeting_date_time") or ""
        segments = transcript_data.get("segments", [])
        combined_text = " ".join(
            seg.get("text", "") for seg in segments[:5]
        )

        # Signal 1: meeting_title — check for specific types first
        title_detected = _match_rules(title, field="title")

        # If the title gives a specific type (not generic "City Council"),
        # trust it immediately.
        if title_detected and title_detected.label != "City Council":
            logger.info(f"Detected meeting type '{title_detected.label}' from title: {title}")
            return title_detected

        # Signal 2: first 5 segment texts — can override a generic title
        text_detected = _match_rules(combined_text, field="text")
        if text_detected and text_detected.label != "City Council":
            logger.info(
                f"Detected meeting type '{text_detected.label}' from opening segment text"
            )
            return text_detected

        # Signal 3: meeting_date_time (evening detection by scheduled time)
        for rule in MEETING_TYPE_RULES:
            time_pat = rule.get("time_pattern")
            if time_pat and re.search(time_pat, date_time, re.IGNORECASE):
                result = MeetingType(
                    label=rule["label"],
                    youtube_search_term=rule["youtube_search_term"],
                )
                logger.info(
                    f"Detected meeting type '{result.label}' from scheduled time: {date_time}"
                )
                return result

        # If title said "City Council" (generic), use it now that nothing
        # more specific was found in segments or time.
        if title_detected:
            logger.info(f"Detected meeting type '{title_detected.label}' from title: {title}")
            return title_detected

    # Signal 4: meetings_metadata.json — also keyed by OnBase meeting id, so
    # also joined by date (pkey 2669 = 4/9/26 collided with OnBase 2669 =
    # 9/11/25 evening).
    detected = _lookup_metadata(date, metadata_path)
    if detected:
        logger.info(
            f"Detected meeting type '{detected.label}' from meetings_metadata.json ({date})"
        )
        return detected

    # Fallback
    logger.info("Defaulting to meeting type 'City Council'")
    return MeetingType(label="City Council", youtube_search_term="City Council")


def get_legacy_search_terms(meeting_type: MeetingType) -> list[str]:
    """
    Get fallback search terms for older video titles.

    Older videos (pre-2025) use abbreviations like "TCC" instead of
    "Tampa City Council". Call this if the primary search finds no results.

    Args:
        meeting_type: Detected meeting type.

    Returns:
        List of alternative search strings to try.
    """
    return LEGACY_SEARCH_TERMS.get(meeting_type.label, ["TCC"])


def _match_rules(text: str, field: str) -> Optional[MeetingType]:
    """Match text against detection rules for a given field type."""
    pattern_key = f"{field}_patterns"
    for rule in MEETING_TYPE_RULES:
        patterns = rule.get(pattern_key, [])
        for pattern in patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return MeetingType(
                    label=rule["label"],
                    youtube_search_term=rule["youtube_search_term"],
                )
    return None


def _type_from_record(record: dict) -> Optional[MeetingType]:
    """Resolve a MeetingType from a scraped meeting record (agenda JSON or
    meetings_metadata.json entry): the clerk's meetingName first, then the
    meetingType enum."""
    name = record.get("meetingName") or ""
    if name:
        detected = _match_rules(name, field="title")
        if detected:
            return detected

    raw_type = (record.get("meetingType") or "").lower().strip()
    canonical = METADATA_TYPE_MAP.get(raw_type)
    if canonical:
        for rule in MEETING_TYPE_RULES:
            if rule["label"] == canonical:
                return MeetingType(
                    label=canonical,
                    youtube_search_term=rule["youtube_search_term"],
                )
    return None


_MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}
_LONG_DATE = re.compile(
    r"(january|february|march|april|may|june|july|august|september|october|"
    r"november|december)\s+(\d{1,2}),?\s+(\d{4})", re.IGNORECASE)
_CLOCK = re.compile(r"(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\b", re.IGNORECASE)
_DATE_IN_NAME = re.compile(r"_(\d{4}-\d{2}-\d{2})\.json$")
# A same-day agenda whose scheduled time is further than this from the
# transcript's is not the same meeting.
_MAX_TIME_GAP_MINUTES = 120
# Council evening sessions are gavelled at 5:01 PM; nothing else starts after 4.
_EVENING_STARTS_MINUTES = 16 * 60


def _transcript_when(
    transcript_data: Optional[dict], transcript_path: Optional[str]
) -> tuple[Optional[str], Optional[int]]:
    """(YYYY-MM-DD, minutes since midnight) for a transcript.

    Both come from the clerk's header line, e.g.
    "THURSDAY, SEPTEMBER 10, 2026, 9:00 A.M."; the date falls back to the
    transcript file name (transcript_<pkey>_<YYYY-MM-DD>.json).
    """
    date = None
    minutes = None
    header = (transcript_data or {}).get("meeting_date_time") or ""
    m = _LONG_DATE.search(header)
    if m:
        date = f"{int(m.group(3)):04d}-{_MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    c = _CLOCK.search(header)
    if c:
        hour = int(c.group(1)) % 12 + (12 if c.group(3).upper() == "P" else 0)
        minutes = hour * 60 + int(c.group(2))
    if date is None and transcript_path:
        n = _DATE_IN_NAME.search(str(transcript_path))
        if n:
            date = n.group(1)
    return date, minutes


def _agenda_minutes(record: dict) -> Optional[int]:
    """meetingTime "17:01" → 1021; None when the scrape carries no time."""
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", (record.get("meetingTime") or "").strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def _rule_type(label: str) -> MeetingType:
    for rule in MEETING_TYPE_RULES:
        if rule["label"] == label:
            return MeetingType(label=label, youtube_search_term=rule["youtube_search_term"])
    raise KeyError(label)


def _evening_by_clock(date_time: str) -> bool:
    """The Evening rule's clock test ("5:01 P.M.") on the clerk's header line."""
    for rule in MEETING_TYPE_RULES:
        if rule["label"] == "Evening":
            return bool(re.search(rule["time_pattern"], date_time or "", re.IGNORECASE))
    return False


def _lookup_agenda_by_date(
    date: Optional[str], minutes: Optional[int], agenda_dir: Path
) -> Optional[MeetingType]:
    """Meeting type from the agenda scrape(s) dated *date*.

    Only the clerk's meetingName counts — the enum alone is what the transcript
    signals and meetings_metadata.json already cover, and pre-2026-08 scrapes
    carry no name. Transcript pkeys and OnBase meeting ids are different id
    spaces, so the join is by date.

    One file on the date: its name decides. Several files (CRA 09:00 +
    Evening 17:01, or an addendum next to its parent): if every file is named
    and they all say the same thing, that; otherwise the transcript's
    scheduled time picks the nearest, and every file must carry a
    meetingTime for that to be trusted — an unnamed or untimed sibling means
    the named one is not necessarily this transcript's meeting (1/29/26: a
    9 AM workshop next to an unnamed regular and a named evening). Anything
    ambiguous returns None and the transcript signals decide.
    """
    if not date:
        return None
    agenda_dir = Path(agenda_dir)
    if not agenda_dir.is_dir():
        return None

    records: list[tuple[Optional[int], Optional[MeetingType]]] = []
    for path in sorted(agenda_dir.glob(f"meeting_*_{date}.json")):
        if ".bak" in path.name:
            continue
        try:
            with open(path, "r") as f:
                record = json.load(f)
        except (json.JSONDecodeError, IOError):
            continue
        name = record.get("meetingName")
        detected = _type_from_record({"meetingName": name}) if name else None
        records.append((_agenda_minutes(record), detected))
    if not records:
        return None
    if len(records) == 1:
        return records[0][1]

    types = [t for _, t in records]
    if all(types) and len({t.label for t in types}) == 1:
        return types[0]
    if minutes is None:
        logger.info(f"{len(records)} agenda scrapes on {date} and no clock on the transcript — skipping Signal 0")
        return None
    if any(t_min is None for t_min, _ in records):
        # Pre-meetingTime scrapes: the only clock the agenda carries is the
        # label itself — an "Evening" record is the 5 PM session, everything
        # else is daytime (9/11/25: CRA Regular + City Council Evening, both
        # untimed, transcript 10:15 A.M. → CRA). An unnamed record in the
        # transcript's half of the day means it could be that one → None.
        after_hours = minutes >= _EVENING_STARTS_MINUTES
        half = [t for _, t in records if (t is not None and t.label == "Evening") == after_hours]
        if not half or any(t is None for t in half) or len({t.label for t in half}) != 1:
            logger.info(f"{len(records)} agenda scrapes on {date} cannot be told apart — skipping Signal 0")
            return None
        return half[0]
    by_gap = sorted(((abs(t_min - minutes), t) for t_min, t in records), key=lambda pair: pair[0])
    best_gap = by_gap[0][0]
    if best_gap > _MAX_TIME_GAP_MINUTES:
        return None
    nearest = [t for gap, t in by_gap if gap == best_gap]
    if any(t is None for t in nearest) or len({t.label for t in nearest}) != 1:
        return None
    return nearest[0]


def _lookup_metadata(date: Optional[str], metadata_path: str) -> Optional[MeetingType]:
    """Look up meeting type from meetings_metadata.json by date. Several
    entries on one date that disagree → None (the transcript can't be told
    which one it is)."""
    if not date:
        return None
    path = Path(metadata_path)
    if not path.exists():
        return None

    try:
        with open(path, "r") as f:
            metadata = json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

    found = [
        _type_from_record(meeting)
        for meeting in metadata.get("meetings", [])
        if str(meeting.get("date") or meeting.get("meetingDate") or "") == date
    ]
    found = [t for t in found if t]
    if not found or len({t.label for t in found}) != 1:
        return None
    return found[0]

    try:
        with open(path, "r") as f:
            metadata = json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

    for meeting in metadata.get("meetings", []):
        if str(meeting.get("meetingId")) == str(meeting_id):
            return _type_from_record(meeting)

    return None

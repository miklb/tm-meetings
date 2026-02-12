"""
Meeting Type Detector

Detects meeting type from transcript data to enable automatic YouTube video matching.

The detector checks multiple signals in priority order:
1. meeting_title field (e.g., "TAMPA CITY COUNCIL WORKSHOPS")
2. meeting_date_time field (e.g., contains "5:01 P.M." for evening)
3. First 5 transcript segments text (e.g., "WELCOME TO THE CRA MEETING")

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

# Map the inconsistent meetingType values from meetings_metadata.json
METADATA_TYPE_MAP = {
    "regular": "City Council",
    "council regular": "City Council",
    "council special": "Special",
    "cra regular": "CRA",
    "council evening": "Evening",
    "evening": "Evening",
    "workshop": "Workshop",
    "council workshop": "Workshop",
}


def detect_meeting_type(
    transcript_path: Optional[str] = None,
    transcript_data: Optional[dict] = None,
    meeting_id: Optional[int] = None,
    metadata_path: str = "data/meetings_metadata.json",
) -> MeetingType:
    """
    Detect meeting type from transcript data.

    Checks multiple signals in priority order:
    1. meeting_title field
    2. meeting_date_time field (time-of-day hints)
    3. First 5 segment texts
    4. meetings_metadata.json lookup (if meeting_id provided)
    5. Falls back to "City Council"

    Args:
        transcript_path: Path to transcript JSON file (raw or processed).
        transcript_data: Already-loaded transcript dict (avoids re-reading file).
        meeting_id: Meeting ID for metadata lookup.
        metadata_path: Path to meetings_metadata.json.

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

    # Signal 4: meetings_metadata.json
    if meeting_id is not None:
        detected = _lookup_metadata(meeting_id, metadata_path)
        if detected:
            logger.info(
                f"Detected meeting type '{detected.label}' from meetings_metadata.json"
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


def _lookup_metadata(
    meeting_id: int, metadata_path: str
) -> Optional[MeetingType]:
    """Look up meeting type from meetings_metadata.json."""
    path = Path(metadata_path)
    if not path.exists():
        return None

    try:
        with open(path, "r") as f:
            metadata = json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

    for meeting in metadata.get("meetings", []):
        if str(meeting.get("meetingId")) == str(meeting_id):
            raw_type = meeting.get("meetingType", "").lower().strip()
            canonical = METADATA_TYPE_MAP.get(raw_type)
            if canonical:
                # Find the matching rule to get the youtube_search_term
                for rule in MEETING_TYPE_RULES:
                    if rule["label"] == canonical:
                        return MeetingType(
                            label=canonical,
                            youtube_search_term=rule["youtube_search_term"],
                        )
            break

    return None

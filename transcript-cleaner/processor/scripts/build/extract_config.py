#!/usr/bin/env python3
"""
Auto-extract acronyms from agenda data.

Scans all agenda JSON files for recurring uppercase abbreviations (2-5 letters)
that appear across multiple meetings. Merges discoveries with the existing
curated config so the capitalizer stays up-to-date without manual edits.

Usage:
    python scripts/build/extract_config.py \
        --agenda-dir ../agenda-scraper/data \
        --config data/capitalization_config.json
"""

import json
import re
import argparse
from pathlib import Path
from collections import Counter

# Common English words that happen to be 2-5 chars uppercase in ALL CAPS text.
# These are NOT acronyms — exclude them from auto-detection.
COMMON_WORDS = {
    'a', 'an', 'am', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in',
    'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us',
    'we', 'and', 'are', 'but', 'can', 'did', 'end', 'for', 'get', 'got',
    'had', 'has', 'her', 'him', 'his', 'how', 'its', 'let', 'may', 'new',
    'nor', 'not', 'now', 'old', 'one', 'our', 'out', 'own', 'say', 'she',
    'the', 'too', 'two', 'use', 'was', 'way', 'who', 'why', 'yet', 'you',
    'all', 'any', 'day', 'few', 'off', 'per', 'set', 'top', 'try', 'via',
    'also', 'area', 'back', 'been', 'call', 'case', 'city', 'come', 'date',
    'days', 'done', 'down', 'each', 'even', 'fact', 'file', 'find', 'five',
    'four', 'from', 'fund', 'gave', 'good', 'half', 'have', 'here', 'high',
    'home', 'into', 'item', 'just', 'keep', 'kind', 'know', 'land', 'last',
    'left', 'less', 'like', 'line', 'list', 'long', 'look', 'made', 'main',
    'make', 'many', 'more', 'most', 'move', 'much', 'must', 'name', 'need',
    'next', 'none', 'note', 'once', 'only', 'open', 'over', 'paid', 'part',
    'plan', 'read', 'real', 'rent', 'said', 'same', 'side', 'site', 'some',
    'such', 'sure', 'take', 'tell', 'than', 'that', 'them', 'then', 'they',
    'this', 'time', 'upon', 'used', 'very', 'vote', 'want', 'well', 'went',
    'were', 'what', 'when', 'will', 'with', 'word', 'work', 'year', 'your',
    'about', 'above', 'after', 'added', 'along', 'apply', 'being', 'below',
    'block', 'board', 'both', 'bring', 'build', 'could', 'count', 'court',
    'cover', 'daily', 'early', 'every', 'exact', 'first', 'floor', 'front',
    'given', 'going', 'grant', 'great', 'group', 'house', 'issue', 'large',
    'later', 'least', 'light', 'local', 'major', 'mayor', 'money', 'month',
    'north', 'offer', 'order', 'other', 'place', 'point', 'price', 'prior',
    'right', 'shall', 'short', 'since', 'small', 'south', 'space', 'staff',
    'start', 'state', 'still', 'store', 'taken', 'their', 'there', 'these',
    'thing', 'third', 'those', 'three', 'total', 'under', 'until', 'water',
    'which', 'while', 'whole', 'whose', 'would', 'shall', 'total',
    # Titles and roles
    'mrs', 'mr', 'ms', 'dr', 'sr', 'jr',
}

# Words that look like acronyms but are regular words in meeting context
MEETING_FALSE_POSITIVES = {
    'ave', 'blvd', 'dept', 'dist', 'div', 'est', 'exec', 'gen',
    'govt', 'inc', 'info', 'mgmt', 'misc', 'natl', 'qty', 'req',
    'assn', 'corp', 'intl',
    # Roman numerals
    'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix', 'xi', 'xii',
    # Two-letter state/country codes that aren't acronyms
    'ab', 'ca', 'de', 'hi', 'fl', 'la', 'ma', 'me', 'or',
    # Common short words that appear uppercase in some contexts
    'red', 'cat', 'sat', 'tag', 'rise', 'pipes', 'epic',
    'algo', 'rez', 'mx',
}


def _load_lowercase_words() -> set:
    """Ordinary English words (lowercase dictionary entries only)."""
    try:
        with open('/usr/share/dict/words', encoding='utf-8', errors='ignore') as f:
            return {w.strip() for w in f if w.strip().isalpha() and w.strip().islower()}
    except OSError:
        return set()


def extract_acronyms_from_agendas(agenda_dir: Path, min_meetings: int = 2):
    """Scan agenda JSON files for uppercase abbreviations.

    Returns (discovered, case_counts): the acronyms that appear in at least
    `min_meetings` separate meetings, and for every candidate how often the
    agendas write it in capitals versus any other casing. The counts let
    merge_config reject ordinary words: "SIX" turns up capitalized in a few
    headings, but "six" appears far more often in prose, so it is a word;
    "SHIP" (the housing program) is capitalized every time, so it is an
    acronym even though "ship" is in the dictionary."""
    acronym_pattern = re.compile(r'\b([A-Z]{2,5})\b')
    # Track which meetings each candidate appears in
    acronym_meetings: dict[str, set] = {}
    case_counts: dict[str, list] = {}   # lower -> [upper_count, other_count]

    # Only scraped agendas (mixed case): ALL-CAPS minutes in the same
    # directory would turn every short word into an "acronym".
    json_files = sorted(agenda_dir.glob('meeting_*.json'))
    if not json_files:
        print(f"  ⚠ No JSON files found in {agenda_dir}")
        return set(), {}

    texts_by_meeting = []
    for json_file in json_files:
        try:
            with open(json_file) as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError):
            continue
        if not isinstance(data, dict):
            continue  # discovered-meetings.json is a list

        meeting_id = json_file.stem
        items = data.get('agendaItems', [])
        texts = []
        for item in items:
            for field in ('title', 'rawTitle', 'background'):
                text = item.get(field, '')
                if text:
                    texts.append(text)
        texts_by_meeting.append((meeting_id, texts))

        for text in texts:
            for match in acronym_pattern.findall(text):
                lower = match.lower()
                if lower in COMMON_WORDS or lower in MEETING_FALSE_POSITIVES:
                    continue
                acronym_meetings.setdefault(lower, set()).add(meeting_id)

    # Case evidence for every candidate: capitals vs. any other casing
    for lower in acronym_meetings:
        upper_rx = re.compile(r'\b' + re.escape(lower.upper()) + r'\b')
        any_rx = re.compile(r'\b' + re.escape(lower) + r'\b', re.IGNORECASE)
        upper = other = 0
        for _, texts in texts_by_meeting:
            for text in texts:
                u = len(upper_rx.findall(text))
                upper += u
                other += len(any_rx.findall(text)) - u
        case_counts[lower] = [upper, other]

    # Keep only acronyms appearing in enough meetings
    discovered = set()
    for acronym, meetings in acronym_meetings.items():
        if len(meetings) >= min_meetings:
            discovered.add(acronym)

    return discovered, case_counts


STREET_SUFFIXES = (
    'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'drive', 'dr', 'road',
    'rd', 'lane', 'ln', 'way', 'place', 'pl', 'court', 'ct', 'circle', 'cir',
    'terrace', 'ter', 'highway', 'hwy', 'parkway', 'pkwy', 'causeway',
)
# Capitalized words that are not street names even when they sit in front of
# a suffix inside agenda prose ("The Street", "Of Avenue").
_STREET_NAME_STOP = {'the', 'of', 'and', 'a', 'an', 'on', 'at', 'to', 'in', 'for', 'or'}
_ADDRESS_RE = re.compile(
    r'\b\d+[A-Za-z]?\s+'
    r'(?:(?:N|S|E|W|North|South|East|West)\.?\s+)?'
    r"([A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+){0,2})\s+"
    r'(?:' + '|'.join(STREET_SUFFIXES) + r')\b', re.IGNORECASE)


def extract_streets_from_agendas(agenda_dir: Path) -> set:
    """Street names from addresses in agenda items ("2312 West Grace Street"
    -> "grace"). The capitalizer uses them to case "<name> <suffix>" even
    without a house number ("on Grace Street"). Only addresses with a house
    number count, so prose like "across the street" never contributes."""
    streets = set()
    for agenda_file in agenda_dir.glob('meeting_*.json'):
        try:
            with open(agenda_file) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        for item in data.get('agendaItems', []):
            for field in ('location', 'title', 'background'):
                text = item.get(field) or ''
                for m in _ADDRESS_RE.finditer(text):
                    name = m.group(1).lower()
                    words = name.split()
                    if any(w in _STREET_NAME_STOP for w in words):
                        continue
                    # Numbered streets ("26th") are handled by the number rule
                    if re.fullmatch(r'\d+(st|nd|rd|th)', words[-1]):
                        continue
                    streets.add(name)
    return streets


def extract_neighborhoods_from_geojson(path: Path, field: str | None) -> set:
    """Neighborhood names from a GeoJSON FeatureCollection of neighborhood
    boundaries (any source with one feature per neighborhood). `field` is the
    property holding the name; when omitted the first of AssocLabel, name,
    NAME, Neighborhood is used. Single-word names that are ordinary English
    words ("Downtown") are skipped — capitalizing them everywhere would be
    worse than missing the place."""
    with open(path) as f:
        data = json.load(f)
    features = data.get('features', data if isinstance(data, list) else [])
    candidates = [field] if field else ['AssocLabel', 'name', 'NAME', 'Neighborhood']
    common = set()
    try:
        with open('/usr/share/dict/words', encoding='utf-8', errors='ignore') as f:
            common = {w.strip() for w in f if w.strip().isalpha() and w.strip().islower()}
    except OSError:
        pass
    # Boundary datasets label some polygons with an association name, a
    # status, or several names at once — keep only what reads as a place.
    junk = ('association', 'crimewatch', 'not organized', 'inc', 'partnership',
            'homeowners', 'civic', 'commercial', 'tpost', '(')
    names = set()
    for feat in features:
        props = feat.get('properties', {})
        value = next((props[c] for c in candidates if props.get(c)), None)
        if not value:
            continue
        for part in re.split(r'\s*[|/]\s*|\s+-\s+', str(value)):
            name = ' '.join(part.split()).lower()
            name = re.sub(r'^the\s+', '', name)
            name = re.sub(r'\s+\d+$', '', name)          # "east tampa 1"
            if not name or any(j in name for j in junk):
                continue
            if ' ' not in name and (name in common or len(name) < 4):
                continue
            names.add(name)
    return names


def merge_config(config_file: Path, discovered_acronyms: set,
                 streets: set | None = None, neighborhoods: set | None = None,
                 case_counts: dict | None = None) -> dict:
    """Merge discovered acronyms into the existing config, preserving curated entries.

    Case evidence decides what stays: an ordinary word ("six", "ship") is an
    acronym only if the agendas write it in capitals at least 3 times and
    3x as often as any other way; any other candidate is dropped when the
    agendas write it in mixed case more than a third of the time ("Ybor").
    `acronym_allowlist` in the config bypasses the check."""
    if config_file.exists():
        with open(config_file) as f:
            config = json.load(f)
    else:
        config = {"acronyms": [], "neighborhoods": [], "street_suffixes": []}

    existing = set(config.get('acronyms', []))
    new_acronyms = discovered_acronyms - existing

    if new_acronyms:
        print(f"  + {len(new_acronyms)} new acronyms: {', '.join(sorted(new_acronyms))}")
    else:
        print("  No new acronyms discovered")

    merged = existing | discovered_acronyms
    words = _load_lowercase_words()
    allow = set(w.lower() for w in config.get('acronym_allowlist', []))
    dropped = set()
    for a in sorted(merged):
        if a in allow:
            continue
        upper, other = (case_counts or {}).get(a, [0, 0])
        if a in words:
            # An ordinary word needs positive evidence
            keep = upper >= 3 and upper >= 3 * max(other, 1)
        else:
            # Anything else is out only on counter-evidence: the agendas
            # write it in mixed case more than a third of the time ("Ybor",
            # "Jeb", "Thor" are names, not acronyms)
            keep = other == 0 or upper >= 3 * other
        if not keep:
            dropped.add(a)
    if dropped:
        print(f"  - {len(dropped)} dropped from acronyms (agendas write them as words): "
              f"{', '.join(sorted(dropped))}")
    config['acronyms'] = sorted(merged - dropped)

    if streets is not None:
        existing_streets = set(config.get('streets', []))
        new_streets = streets - existing_streets
        print(f"  + {len(new_streets)} new street names (from agenda addresses)" if new_streets
              else "  No new street names")
        config['streets'] = sorted(existing_streets | streets)

    if neighborhoods is not None:
        existing_n = set(config.get('neighborhoods', []))
        new_n = neighborhoods - existing_n
        print(f"  + {len(new_n)} new neighborhoods: {', '.join(sorted(new_n))}" if new_n
              else "  No new neighborhoods")
        config['neighborhoods'] = sorted(existing_n | neighborhoods)

    return config


def main():
    parser = argparse.ArgumentParser(description='Auto-extract acronyms from agenda data')
    parser.add_argument(
        '--agenda-dir',
        type=Path,
        default=Path(__file__).resolve().parents[4] / 'agenda-scraper' / 'data',
        help='Directory containing agenda JSON files',
    )
    parser.add_argument(
        '--config',
        type=Path,
        default=Path(__file__).resolve().parents[2] / 'data' / 'capitalization_config.json',
        help='Config file to update',
    )
    parser.add_argument(
        '--min-meetings',
        type=int,
        default=2,
        help='Minimum number of meetings an acronym must appear in (default: 2)',
    )
    parser.add_argument(
        '--neighborhoods-geojson',
        type=Path,
        default=None,
        help='GeoJSON of neighborhood boundaries; adds their names to "neighborhoods"',
    )
    parser.add_argument(
        '--neighborhood-field',
        default=None,
        help='Property holding the neighborhood name (default: AssocLabel/name/NAME)',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be added without writing',
    )
    args = parser.parse_args()

    print(f"Scanning {args.agenda_dir} for acronyms...")
    discovered, case_counts = extract_acronyms_from_agendas(args.agenda_dir, args.min_meetings)
    print(f"  Found {len(discovered)} recurring acronyms")

    streets = extract_streets_from_agendas(args.agenda_dir)
    print(f"  Found {len(streets)} street names in agenda addresses")

    neighborhoods = None
    if args.neighborhoods_geojson:
        neighborhoods = extract_neighborhoods_from_geojson(
            args.neighborhoods_geojson, args.neighborhood_field)
        print(f"  Found {len(neighborhoods)} neighborhoods in {args.neighborhoods_geojson.name}")

    config = merge_config(args.config, discovered, streets, neighborhoods, case_counts)

    if args.dry_run:
        print("\n[dry-run] Would write config with these acronyms:")
        print(f"  {', '.join(config['acronyms'])}")
    else:
        with open(args.config, 'w') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
            f.write('\n')
        print(f"  ✓ Wrote {args.config}")


if __name__ == '__main__':
    main()

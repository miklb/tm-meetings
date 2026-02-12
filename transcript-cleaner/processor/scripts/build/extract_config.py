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


def extract_acronyms_from_agendas(agenda_dir: Path, min_meetings: int = 2) -> set:
    """
    Scan agenda JSON files for uppercase abbreviations.
    
    Returns acronyms that appear in at least `min_meetings` separate meetings.
    """
    acronym_pattern = re.compile(r'\b([A-Z]{2,5})\b')
    # Track which meetings each candidate appears in
    acronym_meetings: dict[str, set] = {}

    json_files = sorted(agenda_dir.glob('*.json'))
    if not json_files:
        print(f"  ⚠ No JSON files found in {agenda_dir}")
        return set()

    for json_file in json_files:
        try:
            with open(json_file) as f:
                data = json.load(f)
        except (json.JSONDecodeError, IOError):
            continue

        meeting_id = json_file.stem
        items = data.get('agendaItems', [])

        for item in items:
            # Check title and rawTitle
            for field in ('title', 'rawTitle', 'background'):
                text = item.get(field, '')
                if not text:
                    continue
                matches = acronym_pattern.findall(text)
                for match in matches:
                    lower = match.lower()
                    if lower in COMMON_WORDS or lower in MEETING_FALSE_POSITIVES:
                        continue
                    if lower not in acronym_meetings:
                        acronym_meetings[lower] = set()
                    acronym_meetings[lower].add(meeting_id)

    # Keep only acronyms appearing in enough meetings
    discovered = set()
    for acronym, meetings in acronym_meetings.items():
        if len(meetings) >= min_meetings:
            discovered.add(acronym)

    return discovered


def merge_config(config_file: Path, discovered_acronyms: set) -> dict:
    """Merge discovered acronyms into the existing config, preserving curated entries."""
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

    merged = sorted(existing | discovered_acronyms)
    config['acronyms'] = merged

    return config


def main():
    parser = argparse.ArgumentParser(description='Auto-extract acronyms from agenda data')
    parser.add_argument(
        '--agenda-dir',
        type=Path,
        default=Path(__file__).resolve().parents[3] / 'agenda-scraper' / 'data',
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
        '--dry-run',
        action='store_true',
        help='Show what would be added without writing',
    )
    args = parser.parse_args()

    print(f"Scanning {args.agenda_dir} for acronyms...")
    discovered = extract_acronyms_from_agendas(args.agenda_dir, args.min_meetings)
    print(f"  Found {len(discovered)} recurring acronyms")

    config = merge_config(args.config, discovered)

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

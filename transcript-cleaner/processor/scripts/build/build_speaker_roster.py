#!/usr/bin/env python3
"""
Build an authoritative name roster from transcript speaker labels.

The agenda-derived entity database misses the people who actually run the
meetings (council/CRA members rarely appear as parties in agenda item text).
The raw transcript speaker labels ARE that roster — every person who spoke,
with frequency, and the source preserves intercaps casing ("McCRAY",
"LaCHONE") so proper casing is recoverable.

Output: data/roster_entities.json
  full_names         : {lowercase -> "Proper Cased"}  (always safe to load)
  single_word_names  : {lowercase -> "Proper Cased"}  (first/last tokens that
                        are NOT common English words, so they are safe to use
                        as standalone capitalization rules)

Usage (from processor/):
    python scripts/build/build_speaker_roster.py
    python scripts/build/build_speaker_roster.py --min-count 2
"""

import argparse
import glob
import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

# Speaker labels that are roles/placeholders, not people.
NON_PERSON_LABELS = {
    'unknown', 'clerk', 'the clerk', 'speaker', 'the speaker', 'audience',
    'reporter', 'translator', 'interpreter', 'staff', 'public', 'multiple',
    'multiple speakers', 'crosstalk', 'inaudible', 'mayor', 'chair', 'board',
    'council', 'the board', 'the council',
}

# Tokens that, if present, mark the label as not a clean personal name.
NON_PERSON_TOKENS = {'clerk', 'unknown', 'speaker', 'audience', 'staff', 'public'}

DICT_PATH = '/usr/share/dict/words'


def load_common_words() -> set:
    """Lowercase English words used to keep common-word surnames (Young, Dock,
    Steady, Pope) out of the single-word capitalization map."""
    try:
        with open(DICT_PATH, 'r', encoding='utf-8', errors='ignore') as f:
            return {w.strip().lower() for w in f if w.strip().isalpha()}
    except OSError:
        print(f"  ⚠ {DICT_PATH} not found — single-word filtering disabled")
        return set()


def _case_segment(seg: str) -> str:
    return seg[0].upper() + seg[1:].lower() if seg else seg


def _case_word(word: str) -> str:
    """Title-case one word, preserving intercaps prefixes via the source's own
    casing: 'McCRAY' -> 'McCray', 'LaGASSE' -> 'LaGasse', 'CLENDENIN' -> 'Clendenin'."""
    # Initials like "L."
    if len(word) <= 2 and word.endswith('.'):
        return word[0].upper() + '.'
    # Split at every lowercase->uppercase boundary (the intercap signal).
    segs = re.split(r'(?<=[a-z])(?=[A-Z])', word)
    cased = ''.join(_case_segment(s) for s in segs)
    # Capitalize the letter after an apostrophe (O'Brien, D'Angelo).
    return re.sub(r"(')([a-z])", lambda m: m.group(1) + m.group(2).upper(), cased)


def proper_case(name: str) -> str:
    """Proper-case a full speaker label, handling hyphens and intercaps."""
    return ' '.join(
        '-'.join(_case_word(p) for p in tok.split('-'))
        for tok in name.split()
    )


def _has_intercap(name: str) -> bool:
    """True if any word has an uppercase letter past its first character
    (e.g. 'McKenzie', 'LaChone') — a sign the casing carries real information."""
    return any(any(c.isupper() for c in w[1:]) for w in name.split())


def _prefer_casing(current: str, candidate: str) -> str:
    """When the same name appears under multiple source casings, keep the one
    that preserves intercaps ('McKenzie' over 'Mckenzie')."""
    if _has_intercap(candidate) and not _has_intercap(current):
        return candidate
    return current


def is_person_label(label: str) -> bool:
    """Keep only clean 2-4 token personal names (no digits, no role words)."""
    low = label.lower().strip()
    if low in NON_PERSON_LABELS:
        return False
    tokens = label.split()
    if not (2 <= len(tokens) <= 4):
        return False
    if any(any(c.isdigit() for c in tok) for tok in tokens):
        return False
    if any(t.lower() in NON_PERSON_TOKENS for t in tokens):
        return False
    # Every token must be alpha (allowing internal hyphen, apostrophe, or a
    # trailing period for initials).
    return all(re.fullmatch(r"[A-Za-z][A-Za-z'\-]*\.?", tok) for tok in tokens)


def build_roster(transcript_glob: str, min_count: int) -> dict:
    counts = Counter()
    for path in glob.glob(transcript_glob):
        try:
            data = json.load(open(path, encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            continue
        for seg in data.get('segments', []):
            label = (seg.get('speaker') or '').strip()
            if label:
                counts[label] += 1

    common = load_common_words()

    # Pass 1: best proper-casing and total count per name (merging source
    # casing variants, preferring the one that preserves intercaps).
    full_names = {}
    name_counts = Counter()
    for label, n in counts.items():
        if n < min_count or not is_person_label(label):
            continue
        proper = proper_case(label)
        key = proper.lower()
        full_names[key] = _prefer_casing(full_names.get(key, proper), proper)
        name_counts[full_names[key]] += n

    # Pass 2: derive single-word rules from the finalized names, excluding any
    # first/last token that is a common English word ("Young"/"Dock"/"Pope").
    single_word_names = {}
    for proper in full_names.values():
        tokens = proper.split()
        for tok in (tokens[0], tokens[-1]):
            t = tok.lower().rstrip('.')
            if len(t) >= 3 and t.isalpha() and t not in common:
                single_word_names[t] = tok

    return {
        'generated_at': date.today().isoformat(),
        'source': 'transcript speaker labels (data/transcripts/*.json)',
        'min_count': min_count,
        'counts': dict(sorted(name_counts.items(), key=lambda x: -x[1])),
        'full_names': dict(sorted(full_names.items())),
        'single_word_names': dict(sorted(single_word_names.items())),
    }


def main():
    parser = argparse.ArgumentParser(description='Build name roster from speaker labels')
    parser.add_argument('--transcripts', default='data/transcripts/*.json',
                        help='Glob for raw transcript JSON files')
    parser.add_argument('--output', type=Path, default=Path('data/roster_entities.json'))
    parser.add_argument('--min-count', type=int, default=1,
                        help='Minimum speaker-segment count to include a name')
    args = parser.parse_args()

    roster = build_roster(args.transcripts, args.min_count)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(roster, f, indent=2, ensure_ascii=False)

    print(f"✓ {len(roster['full_names'])} names, "
          f"{len(roster['single_word_names'])} single-word rules")
    print(f"  Saved to {args.output}")
    top = list(roster['counts'].items())[:12]
    print("  Top speakers:")
    for name, n in top:
        print(f"    {n:5} {name}")


if __name__ == '__main__':
    main()

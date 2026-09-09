#!/usr/bin/env python3
"""Measure the capitalizer against the transcripts that are actually published.

Runs the current capitalizer over the raw ALL-CAPS transcripts into a preview
directory (nothing under data/ is touched unless you pass --out data/processed)
and compares the result with the baseline processed transcripts:

  * counts of known failure classes (lowercase i'm, "$1.5 Million", "mr.",
    "May be", "ITs", flattened intercaps, "Across The Street") before/after;
  * the mid-sentence capitalized ordinary words that are not in any entity
    list — the over-capitalization watch list — before/after;
  * the most frequent word-level changes, with an example each;
  * a diff sample file (segments that changed) for reading by eye.

Usage (from transcript-cleaner/processor/):
    venv/bin/python scripts/build/capitalizer_report.py                 # all transcripts, temp dir
    venv/bin/python scripts/build/capitalizer_report.py --year 2026 --limit 5
    venv/bin/python scripts/build/capitalizer_report.py --out /tmp/preview --gliner
"""

import argparse
import collections
import contextlib
import glob
import io
import json
import re
import sys
import tempfile
import time
from pathlib import Path

PROCESSOR_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROCESSOR_DIR))

from src.capitalize_transcript import TranscriptCapitalizer  # noqa: E402

RAW_DIR = PROCESSOR_DIR / 'data' / 'transcripts'
BASELINE_DIR = PROCESSOR_DIR / 'data' / 'processed'

FAILURE_CLASSES = {
    "lowercase i'm / i'll": re.compile(r"\bi'(ll|m|ve|d)\b"),
    "$N Million/Billion": re.compile(r"\$[\d.,]+ (Million|Billion|Thousand)\b"),
    "lowercase mr./ms./dr.": re.compile(r"\b(mr|ms|mrs|dr)\. [A-Za-z]"),
    "'May be/have/not' (modal capitalized)": re.compile(r"\bMay (be|have|not|want|need|also|recall|know)\b"),
    "ITs": re.compile(r"\bITs\b"),
    "flattened Mc- names": re.compile(r"\bMc[a-z]{3,}\b"),
    "Title-Cased '… The Street'": re.compile(r"\b(Across|Down|Up|On|Of) The (Street|Road)\b"),
    "'the Mayor' title-cased mid-sentence": re.compile(r"[a-z,] The (Mayor|Chair|Chairman|Public|People|Council|City)\b"),
}


def load_common_words():
    try:
        with open('/usr/share/dict/words', encoding='utf-8', errors='ignore') as f:
            return {w.strip() for w in f if w.strip().isalpha() and w.strip().islower()}
    except OSError:
        return set()


def known_entity_words(cap):
    words = set()
    for src in (cap.standard_lookup, cap.agenda_entities, cap.known_surnames, cap.context_surnames):
        for k in src:
            for w in re.split(r"[^a-z']+", k.lower()):
                if w:
                    words.add(w)
    words |= {n.lower() for n in cap.neighborhoods} | set(cap.streets) | set(cap.acronyms)
    # Intended capitalizations that are ordinary words: role titles before a
    # name and courtesy titles.
    from src.capitalize_transcript import _ROLE_TITLES, _TITLE_ABBREVS
    words |= set(_ROLE_TITLES) | set(_TITLE_ABBREVS)
    return words


def metrics(files, common, known):
    counts = collections.Counter()
    examples = collections.defaultdict(list)
    overcap = collections.Counter()
    overcap_ex = {}
    segments = 0
    for f in files:
        with open(f) as fh:
            segs = json.load(fh).get('segments', [])
        for s in segs:
            t = s.get('text', '')
            segments += 1
            for name, rx in FAILURE_CLASSES.items():
                for m in rx.finditer(t):
                    counts[name] += 1
                    if len(examples[name]) < 2:
                        examples[name].append(t[max(0, m.start() - 30):m.end() + 30].replace('\n', ' '))
            for m in re.finditer(r"\b([A-Z][a-z]{3,})\b", t):
                if m.start() == 0:
                    continue
                before = t[:m.start()].rstrip()
                if before and before[-1] in '.!?"':
                    continue
                w = m.group(1)
                if w.lower() in common and w.lower() not in known:
                    overcap[w] += 1
                    overcap_ex.setdefault(w, t[max(0, m.start() - 30):m.end() + 30].replace('\n', ' '))
    return segments, counts, examples, overcap, overcap_ex


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', type=Path, default=None, help='preview directory (default: a temp dir)')
    ap.add_argument('--baseline', type=Path, default=BASELINE_DIR, help='directory to compare against')
    ap.add_argument('--year', default=None, help='only transcripts from this year')
    ap.add_argument('--limit', type=int, default=None, help='only the first N transcripts')
    ap.add_argument('--gliner', action='store_true', help='run with GLiNER on (slow)')
    ap.add_argument('--sample', type=int, default=200, help='changed segments to write to diff-sample.txt')
    args = ap.parse_args()

    raw_files = sorted(RAW_DIR.glob('transcript_*.json'))
    if args.year:
        raw_files = [f for f in raw_files if f"_{args.year}-" in f.name]
    if args.limit:
        raw_files = raw_files[:args.limit]
    if not raw_files:
        print("No raw transcripts matched.")
        sys.exit(1)

    out_dir = args.out or Path(tempfile.mkdtemp(prefix='capitalizer-preview-'))
    out_dir.mkdir(parents=True, exist_ok=True)

    with contextlib.redirect_stdout(io.StringIO()):
        cap = TranscriptCapitalizer(use_gliner=args.gliner)
    print(f"Capitalizer: {len(cap.agenda_entities)} agenda/roster entities, "
          f"{len(cap.known_surnames)} standalone surnames, {len(cap.standard_lookup)} standard, "
          f"{len(cap.streets)} streets, {len(cap.neighborhoods)} neighborhoods, GLiNER={'on' if args.gliner else 'off'}")

    started = time.time()
    pairs = []
    for raw in raw_files:
        with open(raw) as f:
            data = json.load(f)
        with contextlib.redirect_stdout(io.StringIO()):
            result = cap.process_transcript(data)
        stem = raw.name.replace('transcript_', 'processed_transcript_')
        out_file = out_dir / stem
        with open(out_file, 'w') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        base_file = args.baseline / stem
        if base_file.exists():
            pairs.append((base_file, out_file))
    print(f"Processed {len(raw_files)} transcripts in {time.time() - started:.0f}s -> {out_dir}")
    print(f"Baseline pairs: {len(pairs)}\n")

    common = load_common_words()
    known = known_entity_words(cap)
    base_files = [b for b, _ in pairs]
    new_files = [n for _, n in pairs]
    b_segments, b_counts, b_ex, b_over, b_over_ex = metrics(base_files, common, known)
    n_segments, n_counts, n_ex, n_over, n_over_ex = metrics(new_files, common, known)

    print(f"{'failure class':45} {'baseline':>9} {'preview':>9}")
    for name in FAILURE_CLASSES:
        print(f"{name:45} {b_counts[name]:9} {n_counts[name]:9}")
        for e in n_ex[name][:1]:
            print(f"      preview e.g. …{e}…")
    print(f"\n{'over-capitalization watch list (total)':45} {sum(b_over.values()):9} {sum(n_over.values()):9}")
    print("  word              baseline  preview   preview example")
    seen = set()
    for w, _ in (b_over + n_over).most_common(30):
        seen.add(w)
        print(f"  {w:16} {b_over[w]:9} {n_over[w]:8}   {n_over_ex.get(w, b_over_ex.get(w, ''))[:70]}")

    # Word-level changes
    changes = collections.Counter()
    change_ex = {}
    sample = []
    for base_file, new_file in pairs:
        with open(base_file) as f:
            b = json.load(f).get('segments', [])
        with open(new_file) as f:
            n = json.load(f).get('segments', [])
        for sb, sn in zip(b, n):
            tb, tn = sb.get('text', ''), sn.get('text', '')
            if tb == tn:
                continue
            if len(sample) < args.sample:
                sample.append((base_file.name, sb.get('timestamp', ''), tb, tn))
            for wb, wn in zip(tb.split(), tn.split()):
                if wb != wn:
                    changes[(wb, wn)] += 1
                    change_ex.setdefault((wb, wn), tn[:90])
    print(f"\nDistinct word changes: {len(changes)}; top 40 (baseline -> preview):")
    for (wb, wn), c in changes.most_common(40):
        print(f"{c:6}  {wb:>18} -> {wn:<18}  {change_ex[(wb, wn)][:70]}")

    sample_path = out_dir / 'diff-sample.txt'
    with open(sample_path, 'w') as f:
        for name, ts, tb, tn in sample:
            f.write(f"== {name} {ts}\n- {tb}\n+ {tn}\n\n")
    print(f"\nChanged-segment sample: {sample_path} ({len(sample)} segments)")
    print(f"Preview transcripts:    {out_dir}")


if __name__ == '__main__':
    main()

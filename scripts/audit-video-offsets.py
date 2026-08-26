#!/usr/bin/env python3
"""
Audit video_mapping_<TID>.json offset_seconds values for plausibility.

For every video part, computes the transcript span assigned to that part and
checks it against offset_seconds + video duration, flags large/zero offsets,
missing transcript_start_time on multi-part videos, and mismatches against
the offset_seconds/transcript_start_time stored in data/meetings.db.

Read-only. Prints a table sorted by severity. Does not modify any files.

Usage: python3 scripts/audit-video-offsets.py                # every mapping file
       python3 scripts/audit-video-offsets.py --tid 2697     # one meeting (skips the DB
                                                             # comparison — used as a
                                                             # pre-DB-rebuild gate)
       ... --strict                                          # exit 1 if anything is flagged
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPING_DIR = os.path.join(REPO_ROOT, 'transcript-cleaner', 'processor', 'data')
PROCESSED_DIR = os.path.join(MAPPING_DIR, 'processed')
DB_PATH = os.path.join(REPO_ROOT, 'data', 'meetings.db')

OVERSHOOT_SLACK = 300      # seconds — how far past video end the span may run
LARGE_OFFSET_THRESHOLD = 1800  # seconds


def parse_iso_duration(duration_str):
    if not duration_str or not duration_str.startswith('PT'):
        return None
    s = duration_str[2:]
    hours = minutes = seconds = 0
    if 'H' in s:
        h, s = s.split('H')
        hours = int(h)
    if 'M' in s:
        m, s = s.split('M')
        minutes = int(m)
    if 'S' in s:
        seconds = int(s.replace('S', ''))
    return hours * 3600 + minutes * 60 + seconds


def parse_timestamp_to_seconds(ts):
    ts = ts.strip().upper()
    try:
        dt = datetime.strptime(ts, '%I:%M:%S%p')
    except ValueError:
        dt = datetime.strptime(ts, '%I:%M%p')
    return dt.hour * 3600 + dt.minute * 60 + dt.second


def find_processed_transcript(tid):
    matches = glob.glob(os.path.join(PROCESSED_DIR, f'processed_transcript_{tid}_*.json'))
    return matches[0] if matches else None


def load_segments(transcript_path):
    with open(transcript_path) as f:
        data = json.load(f)
    segs = data.get('segments', data.get('transcript', []))
    out = []
    for s in segs:
        ts = s.get('timestamp')
        if not ts:
            continue
        try:
            secs = parse_timestamp_to_seconds(ts)
        except ValueError:
            continue
        out.append((ts, secs))
    return out


def load_db_videos():
    """video_id -> (offset_seconds, transcript_start_time) from meetings.db."""
    result = {}
    if not os.path.exists(DB_PATH):
        return result
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute('SELECT video_id, offset_seconds, transcript_start_time FROM videos')
    for video_id, offset_seconds, transcript_start_time in cur.fetchall():
        result[video_id] = (offset_seconds, transcript_start_time)
    conn.close()
    return result


def audit(tid=None, check_db=True):
    db_videos = load_db_videos() if check_db else None
    pattern = f'video_mapping_{tid}.json' if tid else 'video_mapping_*.json'
    mapping_files = sorted(glob.glob(os.path.join(MAPPING_DIR, pattern)))
    if tid and not mapping_files:
        print(f'no mapping file for transcript {tid} ({pattern})')
        return 1

    rows = []  # each: dict of computed fields + flags list

    for mf in mapping_files:
        try:
            with open(mf) as f:
                mapping = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            rows.append({
                'tid': os.path.basename(mf), 'part': '-', 'video_id': '-',
                'flags': [f'UNREADABLE MAPPING FILE: {e}'], 'severity': 100,
            })
            continue

        tid = mapping.get('meeting_id')
        meeting_date = mapping.get('meeting_date', '?')
        videos = mapping.get('videos', [])
        if not videos:
            continue

        transcript_path = find_processed_transcript(tid)
        segments = load_segments(transcript_path) if transcript_path else []

        # Sort parts for boundary computation
        videos_sorted = sorted(videos, key=lambda v: v.get('part', 1))

        # Precompute each part's baseline (transcript_start_time or first
        # segment) and the boundary (next part's baseline, or end of transcript)
        part_boundaries = []
        for i, v in enumerate(videos_sorted):
            tst = v.get('transcript_start_time')
            if tst:
                try:
                    baseline_secs = parse_timestamp_to_seconds(tst)
                except ValueError:
                    baseline_secs = None
            else:
                baseline_secs = segments[0][1] if segments else None
            part_boundaries.append(baseline_secs)

        for i, v in enumerate(videos_sorted):
            part = v.get('part', 1)
            video_id = v.get('video_id', '?')
            offset = v.get('offset_seconds')
            tst = v.get('transcript_start_time')
            duration_str = v.get('duration')
            duration_secs = parse_iso_duration(duration_str)

            baseline_secs = part_boundaries[i]
            next_baseline_secs = part_boundaries[i + 1] if i + 1 < len(part_boundaries) else None

            # Segments belonging to this part: timestamp >= baseline,
            # and < next part's baseline (if any)
            part_segments = []
            if baseline_secs is not None:
                for ts, secs in segments:
                    if secs < baseline_secs - 60:  # small slack for midnight edge cases
                        continue
                    if next_baseline_secs is not None and secs >= next_baseline_secs:
                        continue
                    part_segments.append((ts, secs))

            flags = []
            severity = 0

            first_ts = part_segments[0][0] if part_segments else None
            last_ts = part_segments[-1][0] if part_segments else None
            span = None
            if part_segments:
                span = part_segments[-1][1] - part_segments[0][1]

            # (i) overshoot
            if offset is not None and span is not None and duration_secs is not None:
                total = offset + span
                if total > duration_secs + OVERSHOOT_SLACK:
                    over_by = total - duration_secs
                    flags.append(f'OVERSHOOT: offset+span={total}s > duration={duration_secs}s by {over_by}s')
                    severity += 3

            # (ii) large offset
            if offset is not None and offset > LARGE_OFFSET_THRESHOLD:
                flags.append(f'LARGE OFFSET: {offset}s (>{LARGE_OFFSET_THRESHOLD}s) — verify manually')
                severity += 1  # can be legitimate (evening session in combined video)

            # (iii) offset==0 with transcript_start_time null (only meaningful
            # signal if this is not part 1 with a plausible near-zero start)
            if offset == 0 and not tst:
                flags.append('offset=0 AND transcript_start_time=null (unverified default?)')
                severity += 2

            # (iv) multi-part video missing transcript_start_time
            if len(videos_sorted) > 1 and part > 1 and not tst:
                flags.append(f'MULTI-PART part {part} missing transcript_start_time')
                severity += 3

            # No transcript found at all for this meeting
            if not transcript_path:
                flags.append('NO PROCESSED TRANSCRIPT FOUND for this meeting_id')
                severity += 2
            elif not segments:
                flags.append('processed transcript has no usable segments')
                severity += 2
            elif not part_segments:
                flags.append('NO transcript segments matched to this part (baseline/boundary problem)')
                severity += 3

            # DB comparison (skipped in --tid gate mode: the DB is rebuilt after)
            db_entry = db_videos.get(video_id) if db_videos is not None else False
            if db_entry is False:
                pass
            elif db_entry is None:
                flags.append('NOT IN DB (videos table) — DB rebuild needed?')
                severity += 2
            else:
                db_offset, db_tst = db_entry
                if offset is not None and db_offset is not None and int(offset) != int(db_offset):
                    flags.append(f'DB MISMATCH: mapping offset={offset} vs DB offset={db_offset}')
                    severity += 3
                if (tst or None) != (db_tst or None):
                    flags.append(f'DB MISMATCH: mapping transcript_start_time={tst!r} vs DB={db_tst!r}')
                    severity += 2

            rows.append({
                'tid': tid,
                'date': meeting_date,
                'part': part,
                'video_id': video_id,
                'offset': offset,
                'tst': tst,
                'duration_secs': duration_secs,
                'first_ts': first_ts,
                'last_ts': last_ts,
                'span': span,
                'flags': flags,
                'severity': severity,
            })

    # Sort: flagged first (highest severity), then unflagged
    rows.sort(key=lambda r: -r['severity'])

    flagged = [r for r in rows if r['severity'] > 0]
    clean = [r for r in rows if r['severity'] == 0]

    print(f'{len(rows)} video parts audited across {len(mapping_files)} mapping files.')
    print(f'{len(flagged)} flagged, {len(clean)} clean.\n')

    print('=' * 100)
    print('FLAGGED (sorted by severity, high to low)')
    print('=' * 100)
    for r in flagged:
        print(f"\ntranscript_{r['tid']} ({r.get('date','?')}) part {r.get('part','?')} "
              f"video={r.get('video_id','?')}  severity={r['severity']}")
        print(f"  offset={r.get('offset')}  transcript_start_time={r.get('tst')!r}  "
              f"duration={r.get('duration_secs')}s  span={r.get('span')}  "
              f"first_ts={r.get('first_ts')}  last_ts={r.get('last_ts')}")
        for fl in r['flags']:
            print(f'  - {fl}')

    print('\n' + '=' * 100)
    print(f'CLEAN ({len(clean)} video parts, no flags)')
    print('=' * 100)
    for r in clean:
        print(f"  transcript_{r['tid']} ({r.get('date','?')}) part {r.get('part','?')} "
              f"video={r.get('video_id','?')}  offset={r.get('offset')}  span={r.get('span')}  "
              f"duration={r.get('duration_secs')}")
    return 1 if flagged else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tid', type=int, default=None, help='audit one meeting only (skips DB comparison)')
    ap.add_argument('--strict', action='store_true', help='exit 1 if any part is flagged')
    args = ap.parse_args()
    rc = audit(tid=args.tid, check_db=args.tid is None)
    sys.exit(rc if args.strict else 0)

#!/usr/bin/env python3
"""
Driver for scripts/verify-offset.py — walks a list of transcript IDs, checks
every video part in each video_mapping_<TID>.json, and logs results.

Usage: python3 scripts/run-offset-verification.py <TID> [<TID> ...]

Writes progress to docs/plans/offset-verify.log and structured results to
docs/plans/offset-verify-results.jsonl (append mode; safe to resume).
Read-only with respect to mapping/transcript files.
"""
import glob
import json
import os
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPING_DIR = os.path.join(REPO_ROOT, 'transcript-cleaner', 'processor', 'data')
LOG_PATH = os.path.join(REPO_ROOT, 'docs', 'plans', 'offset-verify.log')
RESULTS_PATH = os.path.join(REPO_ROOT, 'docs', 'plans', 'offset-verify-results.jsonl')
VERIFY_SCRIPT = os.path.join(REPO_ROOT, 'scripts', 'verify-offset.py')

SKIP_TIDS = {2646, 2659, 2680}


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, 'a') as f:
        f.write(line + '\n')


def already_done():
    done = set()
    if os.path.exists(RESULTS_PATH):
        with open(RESULTS_PATH) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                done.add((r.get('tid'), r.get('video_id'), r.get('part')))
    return done


def main():
    tids = [int(x) for x in sys.argv[1:]]
    if not tids:
        print("usage: run-offset-verification.py <TID> [<TID> ...]", file=sys.stderr)
        sys.exit(1)

    done = already_done()

    for tid in tids:
        if tid in SKIP_TIDS:
            log(f"TID {tid}: SKIPPED (known-bad, already fixed / being reprocessed)")
            continue

        mapping_path = os.path.join(MAPPING_DIR, f'video_mapping_{tid}.json')
        if not os.path.exists(mapping_path):
            log(f"TID {tid}: NO MAPPING FILE")
            with open(RESULTS_PATH, 'a') as f:
                f.write(json.dumps({'ok': False, 'tid': tid, 'video_id': None, 'part': None,
                                     'reason': 'no mapping file'}) + '\n')
            continue

        with open(mapping_path) as f:
            mapping = json.load(f)
        videos = sorted(mapping.get('videos', []), key=lambda v: v.get('part', 1))
        if not videos:
            log(f"TID {tid}: NO VIDEOS in mapping")
            continue

        for v in videos:
            video_id = v.get('video_id')
            part = v.get('part', 1)
            key = (tid, video_id, part)
            if key in done:
                log(f"TID {tid} part {part} ({video_id}): already done, skipping")
                continue

            log(f"TID {tid} part {part} ({video_id}): checking...")
            try:
                r = subprocess.run(
                    [sys.executable, VERIFY_SCRIPT, '--tid', str(tid), f'--video-id={video_id}',
                     '--part', str(part)],
                    capture_output=True, text=True, timeout=600)
                out = r.stdout.strip().splitlines()
                result = json.loads(out[-1]) if out else {'ok': False, 'reason': f'no output; stderr={r.stderr[-500:]}'}
            except subprocess.TimeoutExpired:
                result = {'ok': False, 'reason': 'timed out'}
            except Exception as e:
                result = {'ok': False, 'reason': f'exception: {e}'}

            result.setdefault('tid', tid)
            result.setdefault('video_id', video_id)
            result.setdefault('part', part)

            with open(RESULTS_PATH, 'a') as f:
                f.write(json.dumps(result) + '\n')

            if result.get('ok'):
                log(f"TID {tid} part {part} ({video_id}): {result['verdict']} "
                    f"drift={result['drift']:.1f}s conf={result['confidence']:.2f} "
                    f"predicted={result['predicted']} observed={result['observed']:.1f}")
            else:
                log(f"TID {tid} part {part} ({video_id}): FAILED - {result.get('reason')}")

    log("=== batch complete ===")


if __name__ == '__main__':
    main()

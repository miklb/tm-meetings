#!/usr/bin/env python3
"""
Re-run video offset detection for already-archived meetings using the
word-anchor pipeline (faster-whisper word timestamps + frame-accurate cuts).

Offsets computed before 2026-08-05 carry a 5-10s keyframe-seek inflation
(yt-dlp --download-sections cut at the keyframe before the requested start)
and were matched without word timestamps. This sweep re-downloads each
video's sample window and recomputes its offset with the current pipeline.
Nothing else is touched: transcripts, video mappings, chapters, and gap
detection results are all reused.

Resumable: each completed video ID is recorded in
data/offset_resync_state.json. Re-running skips completed videos, so the
sweep can be stopped (Ctrl-C) and restarted anytime, or run in chunks with
--limit. Failures are logged but not marked done, so they retry next run.

Usage (from transcript-cleaner/processor/):
    venv/bin/python scripts/build/resync_offsets.py --dry-run
    venv/bin/python scripts/build/resync_offsets.py --limit 10
    venv/bin/python scripts/build/resync_offsets.py --since 2025-10-01

After a sweep (or each chunk), rebuild the DB and site from the repo root:
    node scripts/build-db.js && cd site && npx @11ty/eleventy
"""

import argparse
import glob
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

STATE_FILE = Path("data/offset_resync_state.json")
CACHE_DIR = Path("data/whisper_cache")


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def find_meetings():
    """Yield (pkey, date, mapping_file, transcript_file) for every archived
    meeting that has both a video mapping and a processed transcript."""
    meetings = []
    for mapping_file in sorted(glob.glob("data/video_mapping_*.json")):
        m = re.match(r"video_mapping_(\d+)\.json", Path(mapping_file).name)
        if not m:
            continue
        pkey = m.group(1)
        transcripts = sorted(
            glob.glob(f"data/processed/processed_transcript_{pkey}_*.json"))
        if not transcripts:
            print(f"  ⚠️  {Path(mapping_file).name}: no processed transcript — skipping")
            continue
        transcript_file = transcripts[0]
        dm = re.search(r"_(\d{4}-\d{2}-\d{2})\.json$", transcript_file)
        date = dm.group(1) if dm else None
        meetings.append((pkey, date, mapping_file, transcript_file))
    return meetings


def purge_stale_caches(video_id):
    """Delete cached Whisper JSON for this video that lacks word timestamps
    (pre-faster-whisper caches; their timestamps also carry seek error)."""
    removed = 0
    for cache_file in glob.glob(str(CACHE_DIR / f"{video_id}_*.json")):
        try:
            with open(cache_file) as f:
                data = json.load(f)
            segments = data.get("segments", [])
            if not segments or not any(s.get("words") for s in segments):
                Path(cache_file).unlink()
                removed += 1
        except (json.JSONDecodeError, IOError):
            Path(cache_file).unlink()
            removed += 1
    if removed:
        print(f"    🗑  Removed {removed} stale cache file(s)")


def read_offsets(mapping_file):
    """Return {video_id: offset_seconds} from a mapping file."""
    with open(mapping_file) as f:
        mapping = json.load(f)
    return {v["video_id"]: v.get("offset_seconds")
            for v in mapping.get("videos", []) if v.get("video_id")}


def main():
    parser = argparse.ArgumentParser(
        description="Re-run offset detection across archived meetings.")
    parser.add_argument("--limit", type=int, default=None,
                        help="Stop after N videos (for chunked runs)")
    parser.add_argument("--since", default=None,
                        help="Only meetings on/after this date (YYYY-MM-DD)")
    parser.add_argument("--until", default=None,
                        help="Only meetings on/before this date (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would run without doing it")
    args = parser.parse_args()

    state = load_state()
    meetings = find_meetings()

    # Newest first — the most-visited pages get fixed earliest
    meetings.sort(key=lambda m: m[1] or "", reverse=True)

    queue = []
    for pkey, date, mapping_file, transcript_file in meetings:
        if args.since and date and date < args.since:
            continue
        if args.until and date and date > args.until:
            continue
        for video_id, offset in read_offsets(mapping_file).items():
            if video_id in state:
                continue
            queue.append((pkey, date, video_id, offset,
                          mapping_file, transcript_file))

    print(f"{len(queue)} video(s) pending"
          f" ({len(state)} already done)")
    if args.limit:
        queue = queue[:args.limit]
        print(f"Limiting this run to {len(queue)}")

    if args.dry_run:
        for pkey, date, video_id, offset, _, _ in queue:
            print(f"  would run: {date}  pkey={pkey}  {video_id}"
                  f"  (current offset: {offset})")
        return

    done = failed = 0
    for i, (pkey, date, video_id, old_offset,
            mapping_file, transcript_file) in enumerate(queue, 1):
        print(f"\n[{i}/{len(queue)}] {date}  pkey={pkey}  {video_id}"
              f"  (current offset: {old_offset})")
        purge_stale_caches(video_id)

        started = time.time()
        result = subprocess.run([
            sys.executable, "scripts/build/match_whisper_to_transcript.py",
            video_id, transcript_file,
            "--video-mapping", mapping_file,
            "--no-cache",
        ])
        elapsed = int(time.time() - started)

        new_offset = read_offsets(mapping_file).get(video_id)
        if result.returncode == 0 and new_offset is not None:
            delta = (new_offset - old_offset) if old_offset is not None else None
            delta_str = f" (was {old_offset}, Δ{delta:+d}s)" if delta is not None else ""
            print(f"  ✅ offset {new_offset}s{delta_str} in {elapsed}s")
            state[video_id] = {
                "pkey": pkey, "date": date,
                "old_offset": old_offset, "new_offset": new_offset,
                "seconds": elapsed,
                "when": datetime.now().isoformat(timespec="seconds"),
            }
            save_state(state)
            done += 1
        else:
            print(f"  ❌ failed (exit {result.returncode}) — will retry next run")
            failed += 1

        # Courtesy gap between yt-dlp downloads
        if i < len(queue):
            time.sleep(7)

    print(f"\n{'=' * 60}")
    print(f"Done: {done} succeeded, {failed} failed, "
          f"{len(state)} total complete")
    if done:
        deltas = [v["new_offset"] - v["old_offset"] for v in state.values()
                  if v.get("old_offset") is not None]
        if deltas:
            deltas.sort()
            print(f"Offset deltas so far: median {deltas[len(deltas)//2]:+d}s, "
                  f"range {deltas[0]:+d}s..{deltas[-1]:+d}s")
        print("\nRemember to rebuild when finished:")
        print("  node scripts/build-db.js && cd site && npx @11ty/eleventy")


if __name__ == "__main__":
    main()

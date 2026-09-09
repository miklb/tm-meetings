#!/usr/bin/env python3
"""
Record the outcome of the offset-verification gate (archive-meeting.sh Step 3b)
in transcript-cleaner/processor/data/video_mapping_<TID>.json.

build-db.js reads the recorded verdict: a mapping whose verification.status is
"fail" contributes no videos to the database, so a known-wrong offset never
reaches the site. "pass" and "skipped" (--skip-verify) import normally; the
status is there so the operator can see which meetings were never checked.

Usage:
    python3 scripts/record-offset-verification.py --tid 2699 --status pass --audit-rc 0 --verify-rc 0
    python3 scripts/record-offset-verification.py --tid 2699 --status skipped

match_whisper_to_transcript.py clears the record whenever it saves a new
offset, so a re-run of the matcher always needs a fresh verification.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MAPPING_DIR = PROJECT_ROOT / "transcript-cleaner" / "processor" / "data"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tid", type=int, required=True, help="transcript meeting id (video_mapping_<TID>.json)")
    ap.add_argument("--status", choices=["pass", "fail", "skipped"], required=True)
    ap.add_argument("--audit-rc", type=int, default=None, help="exit code of audit-video-offsets.py --strict")
    ap.add_argument("--verify-rc", type=int, default=None, help="exit code of verify-offset.py --strict")
    ap.add_argument("--note", default=None, help="free-text note stored with the record")
    args = ap.parse_args()

    path = MAPPING_DIR / f"video_mapping_{args.tid}.json"
    if not path.exists():
        print(f"record-offset-verification: no mapping at {path}; nothing recorded", file=sys.stderr)
        return 0

    try:
        mapping = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        print(f"record-offset-verification: {path.name} is not valid JSON: {e}", file=sys.stderr)
        return 1

    record = {
        "status": args.status,
        "checked_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    if args.audit_rc is not None:
        record["audit_rc"] = args.audit_rc
    if args.verify_rc is not None:
        record["verify_rc"] = args.verify_rc
    if args.note:
        record["note"] = args.note
    mapping["verification"] = record

    path.write_text(json.dumps(mapping, indent=2) + "\n")
    print(f"record-offset-verification: {path.name} verification={args.status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

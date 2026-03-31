#!/usr/bin/env python3
"""
Transcript Lookup — Scrape the tampagov transcript index to discover
transcript meeting IDs (pkeys) and match them to OnBase agenda meeting IDs.

The index page at https://apps.tampagov.net/cttv_cc_webapp/ is an ASP.NET
Telerik RadGrid with server-side pagination. We scrape page 1 (most recent
~15 meetings) by default, which is sufficient for ongoing pipeline use.
Pass --pages N to fetch more history.

Usage:
    # List all transcript meetings on page 1
    python pipeline/transcript_lookup.py

    # Show only meetings matching a specific date
    python pipeline/transcript_lookup.py --date 2026-02-26

    # Fetch multiple pages (for historical backfill)
    python pipeline/transcript_lookup.py --pages 5

    # Output as JSON (for piping to other scripts)
    python pipeline/transcript_lookup.py --json

    # Match against OnBase meetings in the SQLite DB
    python pipeline/transcript_lookup.py --match-db
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# Auto-activate the processor venv if deps aren't available
_VENV_PYTHON = Path(__file__).resolve().parent.parent / "transcript-cleaner" / "processor" / "venv" / "bin" / "python"
if _VENV_PYTHON.exists() and str(_VENV_PYTHON) != sys.executable:
    try:
        import requests  # noqa: F401 — test if available
    except ImportError:
        os.execv(str(_VENV_PYTHON), [str(_VENV_PYTHON)] + sys.argv)

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://apps.tampagov.net/cttv_cc_webapp"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "meetings.db"

# Map tampagov titles to the meeting_type slugs used in our DB
TITLE_TYPE_MAP = {
    "cra": "cra",
    "community redevelopment": "cra",
    "workshop": "workshop",
    "evening": "evening",
    "special": "special",
}


def classify_meeting_type(title: str) -> str:
    """Infer meeting_type slug from a tampagov title string."""
    lower = title.lower()
    for keyword, slug in TITLE_TYPE_MAP.items():
        if keyword in lower:
            return slug
    return "regular"


def parse_date(date_str: str) -> str | None:
    """Convert M/D/YYYY to YYYY-MM-DD, or return None."""
    try:
        dt = datetime.strptime(date_str.strip(), "%m/%d/%Y")
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None


def fetch_transcript_index(pages: int = 1, session: requests.Session | None = None) -> list[dict]:
    """
    Scrape the tampagov transcript index and return a list of meetings.

    Each entry: {"pkey": str, "date": "YYYY-MM-DD", "title": str, "meeting_type": str}
    """
    sess = session or requests.Session()
    sess.headers.setdefault("User-Agent", "tampa-meetings-pipeline/1.0")

    meetings = []

    # Fetch page 1 (GET)
    resp = sess.get(f"{BASE_URL}/", timeout=30)
    resp.raise_for_status()
    meetings.extend(_parse_grid_page(resp.text))

    if pages > 1:
        # For subsequent pages we need ASP.NET ViewState to POST
        soup = BeautifulSoup(resp.text, "html.parser")
        viewstate = _extract_viewstate(soup)

        for page_num in range(2, pages + 1):
            try:
                resp = _fetch_grid_page(sess, page_num, viewstate)
                resp.raise_for_status()
                page_meetings = _parse_grid_page(resp.text)
                if not page_meetings:
                    break  # No more data
                meetings.extend(page_meetings)
                # Update viewstate for next request
                soup = BeautifulSoup(resp.text, "html.parser")
                viewstate = _extract_viewstate(soup)
            except Exception as e:
                print(f"Warning: Failed to fetch page {page_num}: {e}", file=sys.stderr)
                break

    return meetings


def _parse_grid_page(html: str) -> list[dict]:
    """Parse a single page of the RadGrid table."""
    soup = BeautifulSoup(html, "html.parser")
    meetings = []

    # The grid is a <table> inside the RadGrid. Rows have <td> cells:
    # [0] = "View" link (with pkey), [1] = date, [2] = title
    grid = soup.find("table", class_="rgMasterTable")
    if not grid:
        # Fallback: look for any table with pkey links
        grid = soup

    for row in grid.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 3:
            continue

        # Extract pkey from the View link
        link = cells[0].find("a", href=re.compile(r"pkey=\d+"))
        if not link:
            continue

        pkey_match = re.search(r"pkey=(\d+)", link["href"])
        if not pkey_match:
            continue

        pkey = pkey_match.group(1)
        raw_date = cells[1].get_text(strip=True)
        title = cells[2].get_text(strip=True)

        date = parse_date(raw_date)
        if not date:
            continue

        meeting_type = classify_meeting_type(title)

        meetings.append({
            "pkey": pkey,
            "date": date,
            "title": title,
            "meeting_type": meeting_type,
        })

    return meetings


def _extract_viewstate(soup: BeautifulSoup) -> dict:
    """Extract ASP.NET hidden form fields needed for postback pagination."""
    fields = {}
    for name in ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "__EVENTTARGET", "__EVENTARGUMENT"):
        tag = soup.find("input", {"name": name})
        if tag:
            fields[name] = tag.get("value", "")
    return fields


def _fetch_grid_page(session: requests.Session, page_num: int, viewstate: dict) -> requests.Response:
    """POST to the RadGrid to fetch a specific page number."""
    data = {
        **viewstate,
        "__EVENTTARGET": "ctl00$MainContent$RadGrid1",
        "__EVENTARGUMENT": f"FireCommand:ctl00$MainContent$RadGrid1$ctl00;PageSize;15",
    }
    # RadGrid uses Page command for navigation
    data["__EVENTARGUMENT"] = f"FireCommand:ctl00$MainContent$RadGrid1$ctl00;Page;{page_num}"

    return session.post(f"{BASE_URL}/", data=data, timeout=30)


def match_with_db(transcript_meetings: list[dict]) -> list[dict]:
    """
    Match transcript pkeys to OnBase meeting IDs using the SQLite DB.

    Adds 'onbase_id' and 'has_transcript' keys to each entry.
    Returns only meetings that have a match in the DB.
    """
    if not DB_PATH.exists():
        print(f"Warning: Database not found at {DB_PATH}", file=sys.stderr)
        return transcript_meetings

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    for m in transcript_meetings:
        row = conn.execute(
            "SELECT id, transcript_source_id FROM meetings WHERE date = ? AND meeting_type = ? ORDER BY item_count DESC LIMIT 1",
            (m["date"], m["meeting_type"]),
        ).fetchone()

        if row:
            m["onbase_id"] = row["id"]
            m["already_matched"] = row["transcript_source_id"] is not None
        else:
            m["onbase_id"] = None
            m["already_matched"] = False

    conn.close()
    return transcript_meetings


def find_unprocessed(transcript_meetings: list[dict]) -> list[dict]:
    """
    From the transcript index, find meetings that:
    1. Have a matching OnBase meeting in the DB
    2. Don't already have a transcript_source_id set
    3. Don't already have a processed transcript JSON file

    These are ready to be processed by the pipeline.
    """
    processed_dir = PROJECT_ROOT / "transcript-cleaner" / "processor" / "data" / "processed"

    # Get set of already-processed transcript IDs from filenames
    existing_pkeys = set()
    if processed_dir.exists():
        for f in processed_dir.glob("processed_transcript_*.json"):
            m = re.match(r"processed_transcript_(\d+)_", f.name)
            if m:
                existing_pkeys.add(m.group(1))

    unprocessed = []
    for m in transcript_meetings:
        if m["pkey"] in existing_pkeys:
            continue
        if m.get("already_matched"):
            continue
        unprocessed.append(m)

    return unprocessed


def main():
    parser = argparse.ArgumentParser(description="Look up transcript meeting IDs from tampagov")
    parser.add_argument("--date", help="Filter to specific date (YYYY-MM-DD)")
    parser.add_argument("--pages", type=int, default=1, help="Number of index pages to fetch (default: 1)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--pkey-only", action="store_true", help="Print only the pkey(s), one per line (for scripting)")
    parser.add_argument("--match-db", action="store_true", help="Match against OnBase meetings in SQLite DB")
    parser.add_argument("--unprocessed", action="store_true", help="Show only unprocessed meetings (implies --match-db)")
    args = parser.parse_args()

    meetings = fetch_transcript_index(pages=args.pages)

    if args.date:
        meetings = [m for m in meetings if m["date"] == args.date]

    if args.unprocessed or args.match_db:
        meetings = match_with_db(meetings)

    if args.unprocessed:
        meetings = find_unprocessed(meetings)

    if args.pkey_only:
        for m in meetings:
            print(m["pkey"])
        return

    if args.json:
        print(json.dumps(meetings, indent=2))
    else:
        if not meetings:
            print("No meetings found.")
            return

        # Pretty-print table
        if args.match_db or args.unprocessed:
            print(f"{'pkey':<8} {'Date':<12} {'Type':<10} {'OnBase ID':<10} {'Status':<12} Title")
            print("-" * 80)
            for m in meetings:
                onbase = str(m.get("onbase_id", "—"))
                if m.get("already_matched"):
                    status = "done"
                elif m.get("onbase_id"):
                    status = "ready"
                else:
                    status = "no agenda"
                print(f"{m['pkey']:<8} {m['date']:<12} {m['meeting_type']:<10} {onbase:<10} {status:<12} {m['title']}")
        else:
            print(f"{'pkey':<8} {'Date':<12} {'Type':<10} Title")
            print("-" * 60)
            for m in meetings:
                print(f"{m['pkey']:<8} {m['date']:<12} {m['meeting_type']:<10} {m['title']}")


if __name__ == "__main__":
    main()

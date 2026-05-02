"""Reconcile Tampa City Council agenda financial details with the OpenGov CoA.

Reads meeting JSON files produced by the ``agenda-scraper`` and emits a
**funding manifest** JSON for each
meeting that enriches every financial line item with:

- the raw account code extracted from Summary Sheet context text
- the resolved CoA segment labels (fund / department / object / project)
- the fiscal year qualifier, when present in the context line
- per-item and per-meeting aggregates broken down by fund and department

Usage
-----
    python3 -m opengov.reconcile path/to/meeting_2564_2026-01-08.json
    python3 -m opengov.reconcile path/to/data/*.json --out-dir opengov/data/reports/

Output is written to ``opengov/data/reports/<meetingId>-<date>-funding-manifest.json``.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .coa import DEFAULT_CACHE_PATH, load_cache
from .parse_account_code import parse as _parse_code

DEFAULT_OUT_DIR = Path(__file__).parent / "data" / "reports"

# ------------------------------------------------------------------
# Patterns
# ------------------------------------------------------------------
# Matches 5-6-6 (3 segment) and 5-6-6-7 (4 segment) account codes with
# any single separator: dot, hyphen, or space.
_ACCOUNT_RE = re.compile(
    r"""
    \b(\d{5})        # fund (5 digits)
    [\s.\-]          # separator
    (\d{6})          # department (6 digits)
    [\s.\-]          # separator
    (\d{6})          # object (6 digits)
    (?:[\s.\-](\d{7}))?   # optional project (7 digits)
    \b
    """,
    re.VERBOSE,
)

# Fiscal year: FY2026, FY 2026, FY26, fy26, etc.
_FY_RE = re.compile(r"\bFY\s*(?:20)?(\d{2})\b", re.IGNORECASE)


# ------------------------------------------------------------------
# Extraction helpers
# ------------------------------------------------------------------
def _extract_account_code(context: str) -> str | None:
    """Return the first account code string found in ``context``, or None."""
    m = _ACCOUNT_RE.search(context)
    if not m:
        return None
    parts = [m.group(1), m.group(2), m.group(3)]
    if m.group(4):
        parts.append(m.group(4))
    return ".".join(parts)


def _extract_fiscal_year(context: str) -> int | None:
    """Return the fiscal year as a 4-digit integer, or None."""
    m = _FY_RE.search(context)
    if not m:
        return None
    yr = int(m.group(1))
    return yr + 2000 if yr < 100 else yr


# ------------------------------------------------------------------
# Core enrichment
# ------------------------------------------------------------------
def _enrich_detail(
    detail: dict[str, Any],
    cache: dict[str, Any],
) -> dict[str, Any]:
    """Return an enriched copy of a single ``financialDetails`` entry.

    Looks for an account code in the ``contexts`` list (first match wins),
    resolves it, and merges the result into a new dict.  The original fields
    are preserved unchanged.
    """
    out = dict(detail)
    out.setdefault("accountCode", None)
    out.setdefault("fiscalYear", None)
    out.setdefault("enriched", None)
    out.setdefault("unresolved", [])

    raw_code: str | None = None
    fy: int | None = None
    for ctx in detail.get("contexts") or []:
        if raw_code is None:
            raw_code = _extract_account_code(ctx)
        if fy is None:
            fy = _extract_fiscal_year(ctx)
        if raw_code and fy:
            break

    out["fiscalYear"] = fy

    if not raw_code:
        return out

    out["accountCode"] = raw_code
    parsed = _parse_code(raw_code, cache)
    out["unresolved"] = parsed.unresolved_codes

    enriched: dict[str, Any] = {}
    if parsed.fund and parsed.fund.entry:
        enriched["fund"] = {
            "code": parsed.fund.raw,
            "name": parsed.fund.entry.name,
        }
    if parsed.department and parsed.department.entry:
        enriched["department"] = {
            "code": parsed.department.raw,
            "name": parsed.department.entry.name,
        }
    if parsed.object_ and parsed.object_.entry:
        enriched["object"] = {
            "code": parsed.object_.raw,
            "name": parsed.object_.entry.name,
        }
    if parsed.project and parsed.project.entry:
        enriched["project"] = {
            "code": parsed.project.raw,
            "name": parsed.project.entry.name,
        }
    if fy:
        enriched["fiscalYear"] = fy

    out["enriched"] = enriched or None
    return out


# ------------------------------------------------------------------
# Manifest assembly
# ------------------------------------------------------------------
def _aggregate(details: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute expenditure/decrease/revenue/net totals for a list of details."""
    totals: dict[str, float] = {
        "expenditures": 0.0,
        "decreases": 0.0,
        "revenues": 0.0,
        "other": 0.0,
        "net": 0.0,
    }
    for d in details:
        t = d.get("type") or "unspecified"
        v = d.get("value") or 0.0
        if t == "expenditure":
            totals["expenditures"] += v
            totals["net"] += v
        elif t == "expenditure_decrease":
            totals["decreases"] += v
            totals["net"] -= v
        elif t == "revenue":
            totals["revenues"] += v
            totals["net"] -= v
        else:
            totals["other"] += v
    return {k: round(v, 2) for k, v in totals.items()}


def reconcile_meeting(
    meeting: dict[str, Any],
    cache: dict[str, Any],
) -> dict[str, Any]:
    """Enrich one meeting dict and return a funding manifest dict."""
    by_fund: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"name": None, "expenditures": 0.0, "decreases": 0.0, "revenues": 0.0, "other": 0.0, "net": 0.0}
    )
    by_dept: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"name": None, "expenditures": 0.0, "decreases": 0.0, "revenues": 0.0, "other": 0.0, "net": 0.0}
    )
    total_unresolved = 0
    items_out: list[dict[str, Any]] = []

    for item in meeting.get("agendaItems", []):
        enriched_details: list[dict[str, Any]] = []
        for fd in item.get("financialDetails") or []:
            ed = _enrich_detail(fd, cache)
            enriched_details.append(ed)
            total_unresolved += len(ed.get("unresolved") or [])

            # Roll up into fund/dept aggregates
            fund_info = (ed.get("enriched") or {}).get("fund")
            dept_info = (ed.get("enriched") or {}).get("department")
            t = ed.get("type") or "unspecified"
            v = ed.get("value") or 0.0

            def _add(bucket: dict, t: str, v: float, name: str | None) -> None:
                bucket["name"] = bucket["name"] or name
                if t == "expenditure":
                    bucket["expenditures"] = round(bucket["expenditures"] + v, 2)
                    bucket["net"] = round(bucket["net"] + v, 2)
                elif t == "expenditure_decrease":
                    bucket["decreases"] = round(bucket["decreases"] + v, 2)
                    bucket["net"] = round(bucket["net"] - v, 2)
                elif t == "revenue":
                    bucket["revenues"] = round(bucket["revenues"] + v, 2)
                    bucket["net"] = round(bucket["net"] - v, 2)
                else:
                    bucket["other"] = round(bucket["other"] + v, 2)

            if fund_info:
                _add(by_fund[fund_info["code"]], t, v, fund_info["name"])
            if dept_info:
                _add(by_dept[dept_info["code"]], t, v, dept_info["name"])

        items_out.append(
            {
                "agendaItemId": item.get("agendaItemId"),
                "itemNumber": item.get("number"),
                "fileNumber": item.get("fileNumber"),
                "title": item.get("title"),
                "details": enriched_details,
                "totals": _aggregate(enriched_details),
            }
        )

    # Only include items that have at least one financial detail
    items_with_finance = [i for i in items_out if i["details"]]

    return {
        "meetingId": meeting.get("meetingId"),
        "meetingDate": meeting.get("meetingDate"),
        "formattedDate": meeting.get("formattedDate"),
        "meetingType": meeting.get("meetingType"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coaId": cache.get("coa_id"),
        "items": items_with_finance,
        "summary": {
            "itemCount": len(items_with_finance),
            "byFund": {k: dict(v) for k, v in by_fund.items()},
            "byDepartment": {k: dict(v) for k, v in by_dept.items()},
            "totals": _aggregate(
                [d for i in items_with_finance for d in i["details"]]
            ),
            "unresolvedCount": total_unresolved,
        },
    }


def write_manifest(
    manifest: dict[str, Any],
    out_dir: Path = DEFAULT_OUT_DIR,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    mid = manifest.get("meetingId", "unknown")
    # formattedDate is YYYY-MM-DD; meetingDate is the human string ("January 8, 2026")
    date = manifest.get("formattedDate") or manifest.get("meetingDate", "unknown")
    date = date[:10]  # truncate to YYYY-MM-DD
    out_path = out_dir / f"{mid}-{date}-funding-manifest.json"
    with out_path.open("w") as fh:
        json.dump(manifest, fh, indent=2)
    return out_path


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------
def _cli(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python3 -m opengov.reconcile",
        description=(
            "Reconcile meeting JSON financial details with the OpenGov CoA. "
            "Writes one funding-manifest JSON per input file."
        ),
    )
    parser.add_argument(
        "meeting_files",
        nargs="+",
        metavar="FILE",
        help="Path(s) to meeting JSON files from agenda-scraper/data/.",
    )
    parser.add_argument(
        "--cache-path",
        default=str(DEFAULT_CACHE_PATH),
        help=f"CoA cache file (default: {DEFAULT_CACHE_PATH})",
    )
    parser.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help=f"Output directory for manifests (default: {DEFAULT_OUT_DIR})",
    )
    parser.add_argument(
        "--print",
        dest="print_json",
        action="store_true",
        help="Print manifest JSON to stdout instead of writing files.",
    )
    parser.add_argument(
        "--only-with-accounts",
        action="store_true",
        help="Skip meetings where no account codes were found.",
    )
    args = parser.parse_args(argv)

    cache = load_cache(Path(args.cache_path))
    out_dir = Path(args.out_dir)
    exit_code = 0

    for f in args.meeting_files:
        p = Path(f)
        if not p.exists():
            print(f"ERROR: {f}: file not found")
            exit_code = 1
            continue
        meeting = json.loads(p.read_text())
        manifest = reconcile_meeting(meeting, cache)

        if args.only_with_accounts:
            total_codes = sum(
                1
                for i in manifest["items"]
                for d in i["details"]
                if d.get("accountCode")
            )
            if total_codes == 0:
                continue

        if args.print_json:
            print(json.dumps(manifest, indent=2))
            continue

        out_path = write_manifest(manifest, out_dir)
        totals = manifest["summary"]["totals"]
        unresolved = manifest["summary"]["unresolvedCount"]
        print(
            f"{p.name}: {len(manifest['items'])} items with finance, "
            f"net={totals['net']:+,.2f}, "
            f"unresolved={unresolved} → {out_path.name}"
        )

    return exit_code


if __name__ == "__main__":
    raise SystemExit(_cli())

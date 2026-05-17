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
# Map row.type values from the JS parser to budget-impact direction.
#   +v  the City spends more / loses revenue it expected
#   -v  the City spends less / receives revenue
_TYPE_DIRECTION = {
    "expenditure": +1,
    "expenditure_decrease": -1,
    "revenue": -1,
    "revenue_decrease": +1,
}

_EMPTY_TOTALS = {
    "expenditures": 0.0,
    "decreases": 0.0,
    "revenues": 0.0,
    "revenueDecreases": 0.0,
    "net": 0.0,
}


def _new_totals() -> dict[str, float]:
    return dict(_EMPTY_TOTALS)


def _add_to_totals(bucket: dict[str, float], row_type: str, value: float) -> None:
    """Mutate ``bucket`` in place by adding one row's contribution."""
    if row_type == "expenditure":
        bucket["expenditures"] += value
        bucket["net"] += value
    elif row_type == "expenditure_decrease":
        bucket["decreases"] += value
        bucket["net"] -= value
    elif row_type == "revenue":
        bucket["revenues"] += value
        bucket["net"] -= value
    elif row_type == "revenue_decrease":
        bucket["revenueDecreases"] += value
        bucket["net"] += value
    # unknown types are silently ignored — the JS parser already logs them


def _round_totals(bucket: dict[str, float]) -> dict[str, float]:
    return {k: round(v, 2) for k, v in bucket.items()}


def _compute_reallocation(
    rows: list[dict[str, Any]],
    committed_totals: dict[str, float],
) -> dict[str, Any] | None:
    """Return a reallocation summary block when an item both increases and
    decreases spending (i.e. moves money between line items).

    Returns None when there are no decrease rows (pure new spending or revenue).
    """
    decreases = committed_totals.get("decreases", 0.0)
    increases = committed_totals.get("expenditures", 0.0)
    if decreases == 0.0:
        return None
    imbalance = round(decreases - increases, 2)
    return {
        "decreasesTotal": round(decreases, 2),
        "increasesTotal": round(increases, 2),
        "imbalance": imbalance,
        "balanced": abs(imbalance) <= 1.0,
    }


def _enrich_row(
    row: dict[str, Any],
    cache: dict[str, Any],
) -> dict[str, Any]:
    """Resolve segment names from the CoA cache for one PROJECTED COSTS row.

    The JS parser already produced structured ``fund``/``department``/``object``/
    ``project`` segment codes plus ``fiscalYear``, ``type``, ``value``,
    ``subjectToAppropriation``. This function only adds the human-readable
    names and tracks which segments were not found in the public CoA.
    """
    out = dict(row)
    raw_code = row.get("accountCode") or ""
    parsed = _parse_code(raw_code, cache) if raw_code else None

    enriched: dict[str, Any] = {}
    unresolved: list[str] = []
    if parsed is not None:
        if parsed.fund and parsed.fund.entry:
            enriched["fund"] = {"code": parsed.fund.raw, "name": parsed.fund.entry.name}
        if parsed.department and parsed.department.entry:
            enriched["department"] = {"code": parsed.department.raw, "name": parsed.department.entry.name}
        if parsed.object_ and parsed.object_.entry:
            enriched["object"] = {"code": parsed.object_.raw, "name": parsed.object_.entry.name}
        if parsed.project and parsed.project.entry:
            enriched["project"] = {"code": parsed.project.raw, "name": parsed.project.entry.name}
        unresolved = list(parsed.unresolved_codes)

    out["enriched"] = enriched or None
    out["unresolved"] = unresolved
    return out


def _aggregate_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute committed (current-FY only) and total (all FYs) totals.

    Returns:
        {
          "committed": { totals... },     # rows NOT subject to annual appropriation
          "future":    { totals... },     # rows subject to annual appropriation
          "total":     { totals... },     # both combined
          "byFiscalYear": { "FY26": {...}, "FY27": {...} },
          "headlineFiscalYear": "FY26" | None
        }
    """
    committed = _new_totals()
    future = _new_totals()
    total = _new_totals()
    by_fy: dict[str, dict[str, float]] = defaultdict(_new_totals)

    for r in rows:
        t = r.get("type") or "unknown"
        v = r.get("value") or 0.0
        fy = r.get("fiscalYear")
        is_future = bool(r.get("subjectToAppropriation"))

        _add_to_totals(total, t, v)
        if is_future:
            _add_to_totals(future, t, v)
        else:
            _add_to_totals(committed, t, v)
        if fy:
            _add_to_totals(by_fy[fy], t, v)

    # Headline FY: the earliest non-future-subject FY, falling back to
    # earliest FY overall, falling back to None when no FY tags present.
    fy_committed = sorted(
        {r.get("fiscalYear") for r in rows if r.get("fiscalYear") and not r.get("subjectToAppropriation")}
    )
    fy_any = sorted({r.get("fiscalYear") for r in rows if r.get("fiscalYear")})
    headline_fy = fy_committed[0] if fy_committed else (fy_any[0] if fy_any else None)

    return {
        "committed": _round_totals(committed),
        "future": _round_totals(future),
        "total": _round_totals(total),
        "byFiscalYear": {fy: _round_totals(b) for fy, b in by_fy.items()},
        "headlineFiscalYear": headline_fy,
    }


def reconcile_meeting(
    meeting: dict[str, Any],
    cache: dict[str, Any],
) -> dict[str, Any]:
    """Enrich one meeting dict and return a funding manifest dict.

    Reads each item's ``projectedCosts.rows`` (the new authoritative shape
    produced by ``lib/projected-costs-parser.js``). Items without a
    ``projectedCosts`` block are skipped — they have no parseable budget
    action.
    """
    by_fund: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"name": None, **_new_totals()}
    )
    by_dept: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"name": None, **_new_totals()}
    )
    total_unresolved = 0
    items_out: list[dict[str, Any]] = []

    for item in meeting.get("agendaItems", []):
        pc = item.get("projectedCosts") or {}
        rows_in = pc.get("rows") or []
        if not rows_in:
            continue

        enriched_rows: list[dict[str, Any]] = []
        for raw_row in rows_in:
            er = _enrich_row(raw_row, cache)
            enriched_rows.append(er)
            total_unresolved += len(er.get("unresolved") or [])

            fund_info = (er.get("enriched") or {}).get("fund")
            dept_info = (er.get("enriched") or {}).get("department")
            t = er.get("type") or "unknown"
            v = er.get("value") or 0.0
            if fund_info:
                bucket = by_fund[fund_info["code"]]
                bucket["name"] = bucket["name"] or fund_info["name"]
                _add_to_totals(bucket, t, v)
            if dept_info:
                bucket = by_dept[dept_info["code"]]
                bucket["name"] = bucket["name"] or dept_info["name"]
                _add_to_totals(bucket, t, v)

        item_totals = _aggregate_rows(enriched_rows)
        items_out.append(
            {
                "agendaItemId": item.get("agendaItemId"),
                "itemNumber": item.get("number"),
                "fileNumber": item.get("fileNumber"),
                "title": item.get("title"),
                "fiscalImpactStatement": pc.get("fiscalImpactStatement") or "",
                "rows": enriched_rows,
                "totals": item_totals,
                "reallocation": _compute_reallocation(enriched_rows, item_totals["committed"]),
            }
        )

    # Round fund/dept aggregates for output.
    for bucket in list(by_fund.values()) + list(by_dept.values()):
        for k, v in list(bucket.items()):
            if isinstance(v, float):
                bucket[k] = round(v, 2)

    all_rows = [r for i in items_out for r in i["rows"]]
    summary_totals = _aggregate_rows(all_rows)

    return {
        "meetingId": meeting.get("meetingId"),
        "meetingDate": meeting.get("meetingDate"),
        "formattedDate": meeting.get("formattedDate"),
        "meetingType": meeting.get("meetingType"),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coaId": cache.get("coa_id"),
        "items": items_out,
        "summary": {
            "itemCount": len(items_out),
            "byFund": {k: dict(v) for k, v in by_fund.items()},
            "byDepartment": {k: dict(v) for k, v in by_dept.items()},
            "totals": summary_totals,
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
                for r in i["rows"]
                if r.get("accountCode")
            )
            if total_codes == 0:
                continue

        if args.print_json:
            print(json.dumps(manifest, indent=2))
            continue

        out_path = write_manifest(manifest, out_dir)
        totals = manifest["summary"]["totals"]["committed"]
        unresolved = manifest["summary"]["unresolvedCount"]
        print(
            f"{p.name}: {len(manifest['items'])} items with finance, "
            f"committed net={totals['net']:+,.2f}, "
            f"unresolved={unresolved} → {out_path.name}"
        )

    return exit_code


if __name__ == "__main__":
    raise SystemExit(_cli())

#!/usr/bin/env python3
"""
Probe the public OpenGov reporting API to discover the endpoint that
returns account-level rows for a Transparency report.

Usage:
    python3 opengov/scripts/probe_reporting_api.py
    python3 opengov/scripts/probe_reporting_api.py --report-id 145174

The script:
  1. Fetches entity metadata for Tampa.
  2. Fetches the target report metadata (default: FY2026 Total Budget).
  3. Walks each `data_set` in the report and tries a list of plausible
     row-data endpoint shapes against `reporting.opengov.com`.
  4. Prints which combinations return JSON (HTTP 200 with parseable body)
     versus 404/403/HTML, so we can pick the real endpoint without having
     to scrape the SPA's bundled JS.

No auth, no writes. Safe to run repeatedly.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

import httpx

BASE = "https://reporting.opengov.com/api/v1"
ENTITY_SLUG = "tampa"
DEFAULT_REPORT_ID = 145174  # FY2026 Total Budget


# Candidate endpoint templates. {report}, {dataset}, {entity}, {coa} get
# substituted in. We try GET on each and record the response shape.
CANDIDATES: list[str] = [
    "/reports/{report}/data",
    "/reports/{report}/rows",
    "/reports/{report}/breakdown",
    "/reports/{report}/datasets/{dataset}/data",
    "/reports/{report}/datasets/{dataset}/rows",
    "/datasets/{dataset}",
    "/datasets/{dataset}/data",
    "/datasets/{dataset}/rows",
    "/datasets/{dataset}/values",
    "/entities/{entity}/datasets/{dataset}/data",
    "/entities/{entity}/coa/{coa}",
    "/entities/{entity}/coa/{coa}/accounts",
    "/coa/{coa}",
    "/coa/{coa}/accounts",
    "/chart_of_accounts/{coa}",
    "/chart_of_accounts/{coa}/accounts",
]


def classify(resp: httpx.Response) -> tuple[str, Any]:
    """Return (verdict, sample) describing the response."""
    ct = resp.headers.get("content-type", "")
    if resp.status_code != 200:
        return f"HTTP {resp.status_code}", None
    if "json" not in ct:
        return f"non-json ({ct.split(';')[0]})", None
    try:
        body = resp.json()
    except json.JSONDecodeError:
        return "json-parse-error", None
    if isinstance(body, dict):
        keys = sorted(body.keys())[:8]
        return "JSON object", keys
    if isinstance(body, list):
        return f"JSON array (len={len(body)})", None
    return f"JSON {type(body).__name__}", None


def probe(client: httpx.Client, path: str) -> None:
    url = BASE + path
    try:
        resp = client.get(url, timeout=10.0)
    except httpx.HTTPError as exc:
        print(f"  [error] {path}: {exc}")
        return
    verdict, sample = classify(resp)
    marker = "✓" if verdict.startswith("JSON") else " "
    line = f"  {marker} {resp.status_code} {path:60s} {verdict}"
    if sample:
        line += f"  keys={sample}"
    print(line)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--report-id", type=int, default=DEFAULT_REPORT_ID)
    ap.add_argument("--entity", default=ENTITY_SLUG)
    args = ap.parse_args()

    with httpx.Client(headers={"Accept": "application/json"}) as client:
        print(f"# Entity: {args.entity}")
        ent = client.get(f"{BASE}/entities/{args.entity}").json()
        entity_uuid = ent["uuid"]
        coa_id = ent["default_coa_id"]
        print(f"  uuid={entity_uuid}")
        print(f"  default_coa_id={coa_id}")
        print()

        print(f"# Report {args.report_id}")
        report = client.get(f"{BASE}/reports/{args.report_id}").json()
        datasets = report.get("data_sets", [])
        print(f"  name={report.get('name')!r}  datasets={len(datasets)}")
        for ds in datasets:
            print(
                f"    - id={ds['id']}  fy={ds.get('fiscal_year')}  "
                f"type={ds.get('data_set_type')}  "
                f"name={ds.get('data_set_name')!r}"
            )
        print()

        print("# Probing report-level endpoints")
        for tmpl in CANDIDATES:
            if "{dataset}" in tmpl:
                continue
            probe(
                client,
                tmpl.format(
                    report=args.report_id,
                    entity=entity_uuid,
                    coa=coa_id,
                ),
            )
        print()

        if datasets:
            sample_ds = datasets[-1]["id"]
            print(f"# Probing dataset-level endpoints (using {sample_ds})")
            for tmpl in CANDIDATES:
                if "{dataset}" not in tmpl:
                    continue
                probe(
                    client,
                    tmpl.format(
                        report=args.report_id,
                        entity=entity_uuid,
                        coa=coa_id,
                        dataset=sample_ds,
                    ),
                )

    return 0


if __name__ == "__main__":
    sys.exit(main())

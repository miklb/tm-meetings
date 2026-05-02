"""Chart-of-accounts cache and lookup.

Flattens the ~2,900-node OpenGov package response into a flat
account-code → entry table that the rest of the pipeline can hit
without re-walking the tree.

Cache file shape (data/coa-cache.json):

    {
      "coa_id":      "<uuid>",
      "report_id":   145174,
      "cache_key":   "<server cache key from package response>",
      "fetched_at":  "2026-05-02T12:34:56Z",
      "trees":       {tree_id: {"name": "Funds", "categories": [...]}},
      "data_sets":   [{id, name, year, type, etag}, ...],
      "nodes":       {node_id: {id, parent_id, tree_id, name, depth, account_codes, children}},
      "by_code":     {"01100": [node_id, node_id, ...]}  # usually len 1, occasionally >1
    }
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .client import OpenGovClient

DEFAULT_CACHE_PATH = Path(__file__).parent / "data" / "coa-cache.json"


@dataclass(frozen=True)
class CoAEntry:
    """A single chart-of-accounts node, resolved from an account code."""

    code: str
    node_id: str
    name: str
    tree_id: str
    tree_name: str
    depth: int
    parent_id: str | None
    account_codes: tuple[str, ...]


# ----------------------------------------------------------------------
# Build / persist
# ----------------------------------------------------------------------
def build_cache(
    package: dict[str, Any],
    *,
    report_id: int | str | None = None,
) -> dict[str, Any]:
    """Flatten a raw package response into the on-disk cache shape."""
    trees = {
        tid: {
            "name": t.get("name"),
            "categories": t.get("categories"),
            "long_id": t.get("long_id"),
        }
        for tid, t in package.get("trees", {}).items()
    }

    nodes_out: dict[str, dict[str, Any]] = {}
    by_code: dict[str, list[str]] = defaultdict(list)
    for nid, node in package.get("nodes", {}).items():
        codes = list(node.get("account_codes") or [])
        nodes_out[nid] = {
            "id": nid,
            "parent_id": node.get("parent_id"),
            "tree_id": node.get("tree_id"),
            "name": node.get("name"),
            "depth": node.get("depth"),
            "account_codes": codes,
            "children": list(node.get("children") or []),
        }
        for code in codes:
            by_code[code].append(nid)

    raw_ds = package.get("data_sets") or {}
    if isinstance(raw_ds, dict):
        ds_iter = raw_ds.values()
    else:
        ds_iter = raw_ds
    data_sets = [
        {
            "id": ds.get("id"),
            "description": ds.get("description"),
            "type": ds.get("type"),
            "year": ds.get("year"),
            "etag": ds.get("etag"),
        }
        for ds in ds_iter
        if isinstance(ds, dict)
    ]

    return {
        "coa_id": package.get("coa_id"),
        "report_id": report_id,
        "cache_key": package.get("cache_key"),
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trees": trees,
        "data_sets": data_sets,
        "nodes": nodes_out,
        "by_code": dict(by_code),
    }


def save_cache(cache: dict[str, Any], path: Path = DEFAULT_CACHE_PATH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as fh:
        json.dump(cache, fh, indent=2, sort_keys=True)
    return path


def load_cache(path: Path = DEFAULT_CACHE_PATH) -> dict[str, Any]:
    with path.open() as fh:
        return json.load(fh)


# ----------------------------------------------------------------------
# Refresh helpers
# ----------------------------------------------------------------------
def refresh_from_report(
    report_id: int | str,
    *,
    client: OpenGovClient | None = None,
    cache_path: Path = DEFAULT_CACHE_PATH,
) -> dict[str, Any]:
    """Fetch a fresh package for ``report_id`` and persist it to disk."""
    owns_client = client is None
    client = client or OpenGovClient()
    try:
        package = client.get_package_for_report(report_id)
    finally:
        if owns_client:
            client.close()
    cache = build_cache(package, report_id=report_id)
    save_cache(cache, cache_path)
    return cache


def is_stale(
    cache: dict[str, Any],
    *,
    client: OpenGovClient | None = None,
) -> bool:
    """Return True if any cached dataset's ``etag`` has changed upstream."""
    owns_client = client is None
    client = client or OpenGovClient()
    try:
        for ds in cache.get("data_sets", []):
            ds_id = ds.get("id")
            etag = ds.get("etag")
            if not ds_id:
                continue
            current = client.get_data_set(ds_id)
            if current.get("etag") != etag:
                return True
    finally:
        if owns_client:
            client.close()
    return False


# ----------------------------------------------------------------------
# Lookup
# ----------------------------------------------------------------------
def lookup(cache: dict[str, Any], code: str) -> list[CoAEntry]:
    """Resolve a single account-code segment to one or more CoA entries.

    A given segment usually maps to exactly one node, but a small number
    of codes appear under both the Departments and Liabilities trees in
    Tampa's CoA. Callers should use the ``tree_name`` to disambiguate.
    """
    node_ids = cache.get("by_code", {}).get(code, [])
    nodes = cache.get("nodes", {})
    trees = cache.get("trees", {})
    out: list[CoAEntry] = []
    for nid in node_ids:
        n = nodes.get(nid)
        if not n:
            continue
        tree = trees.get(n.get("tree_id"), {})
        out.append(
            CoAEntry(
                code=code,
                node_id=nid,
                name=n.get("name") or "",
                tree_id=n.get("tree_id") or "",
                tree_name=tree.get("name") or "",
                depth=int(n.get("depth") or 0),
                parent_id=n.get("parent_id"),
                account_codes=tuple(n.get("account_codes") or ()),
            )
        )
    return out


def lookup_many(
    cache: dict[str, Any], codes: Iterable[str]
) -> dict[str, list[CoAEntry]]:
    """Look up several codes in one call. Missing codes map to ``[]``."""
    return {code: lookup(cache, code) for code in codes}


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------
def _cli(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python3 -m opengov.coa",
        description="Manage the OpenGov chart-of-accounts cache.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_refresh = sub.add_parser("refresh", help="Fetch a fresh package and overwrite the cache.")
    p_refresh.add_argument(
        "--report-id",
        default="145174",
        help="OpenGov report ID (default: 145174 = Tampa FY2026 Total Budget)",
    )
    p_refresh.add_argument(
        "--cache-path",
        default=str(DEFAULT_CACHE_PATH),
        help=f"Output path (default: {DEFAULT_CACHE_PATH})",
    )

    p_lookup = sub.add_parser("lookup", help="Resolve one or more account codes against the cache.")
    p_lookup.add_argument("codes", nargs="+", help="Account-code segment(s), e.g. 01100 232900")
    p_lookup.add_argument(
        "--cache-path",
        default=str(DEFAULT_CACHE_PATH),
        help=f"Cache file (default: {DEFAULT_CACHE_PATH})",
    )

    p_check = sub.add_parser("check", help="Check whether the cache is stale.")
    p_check.add_argument(
        "--cache-path",
        default=str(DEFAULT_CACHE_PATH),
        help=f"Cache file (default: {DEFAULT_CACHE_PATH})",
    )

    args = parser.parse_args(argv)

    if args.cmd == "refresh":
        cache = refresh_from_report(
            args.report_id,
            cache_path=Path(args.cache_path),
        )
        leaves = sum(1 for n in cache["nodes"].values() if n.get("account_codes"))
        print(
            f"wrote {args.cache_path}: {len(cache['nodes'])} nodes "
            f"({leaves} with account_codes), {len(cache['by_code'])} unique codes, "
            f"{len(cache['data_sets'])} data_sets"
        )
        return 0

    if args.cmd == "lookup":
        cache = load_cache(Path(args.cache_path))
        for code in args.codes:
            entries = lookup(cache, code)
            if not entries:
                print(f"{code}: (no match)")
                continue
            for e in entries:
                print(f"{code}: {e.tree_name:>14} | depth={e.depth} | {e.name}")
        return 0

    if args.cmd == "check":
        cache = load_cache(Path(args.cache_path))
        stale = is_stale(cache)
        print("STALE" if stale else "fresh")
        return 1 if stale else 0

    return 2


if __name__ == "__main__":
    raise SystemExit(_cli())

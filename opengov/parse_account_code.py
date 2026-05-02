"""Parse Tampa account-code strings into normalized segments.

Tampa Summary Sheets quote accounts in three observed formats
(see ACCOUNT_CODES.md):

    41153.243200.563001.1001574   # 4 segments, dot
    01100 232900 534007           # 3 segments, space (project elided)
    01100-232900-534007-0000000   # 4 segments, hyphen, explicit zero project

Approach:

1. Pull every digit run out of the raw string in left-to-right order.
2. Look each run up in the CoA cache; that tells us which breakdown
   tree (Funds / Departments / object-type / Project) it belongs to.
3. Assemble a structured ``ParsedAccountCode`` with each segment
   resolved (or flagged unresolved). Position matters as a tie-breaker
   when a code collides between two trees.

We deliberately do **not** hard-code segment widths. The CoA returned
by ``opengov.coa`` is the source of truth — if Tampa adds a new fund
prefix or extends a project ID, the parser keeps working as long as
the cache is fresh.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .coa import CoAEntry, lookup

# Tree-name → role mapping. The "role" is the slot we expose on the
# ParsedAccountCode (fund / department / object / project). Multiple
# tree names can map to the same role (e.g. expenses / revenues /
# liabilities all populate the "object" slot — only one will match a
# given segment in practice).
_TREE_TO_ROLE: dict[str, str] = {
    "Funds": "fund",
    "Departments": "department",
    "Project": "project",
    "Expenses": "object",
    "Revenues": "object",
    "Assets": "object",
    "Liabilities & Equities": "object",
    "FTE Count": "object",
}

# Conventional ordering of segments in a Tampa account code; used to
# disambiguate the rare codes that collide across trees (e.g. 215000
# is both a Department and a Liability node).
_POSITION_PREFERENCE: dict[int, tuple[str, ...]] = {
    0: ("fund",),
    1: ("department",),
    2: ("object",),
    3: ("project",),
}

_DIGIT_RUN = re.compile(r"\d+")


@dataclass
class ParsedSegment:
    """One segment of a parsed account code."""

    position: int
    raw: str
    role: str | None  # 'fund' | 'department' | 'object' | 'project' | None
    entry: CoAEntry | None = None
    candidates: list[CoAEntry] = field(default_factory=list)

    @property
    def resolved(self) -> bool:
        return self.entry is not None

    def to_json(self) -> dict[str, Any]:
        return {
            "position": self.position,
            "code": self.raw,
            "role": self.role,
            "name": self.entry.name if self.entry else None,
            "tree": self.entry.tree_name if self.entry else None,
            "node_id": self.entry.node_id if self.entry else None,
            "ambiguous": len(self.candidates) > 1,
        }


@dataclass
class ParsedAccountCode:
    """Result of parsing a single account-code string."""

    raw: str
    segments: list[ParsedSegment]

    @property
    def fund(self) -> ParsedSegment | None:
        return self._role("fund")

    @property
    def department(self) -> ParsedSegment | None:
        return self._role("department")

    @property
    def object_(self) -> ParsedSegment | None:
        return self._role("object")

    @property
    def project(self) -> ParsedSegment | None:
        return self._role("project")

    @property
    def fully_resolved(self) -> bool:
        return all(s.resolved for s in self.segments) and bool(self.segments)

    @property
    def unresolved_codes(self) -> list[str]:
        return [s.raw for s in self.segments if not s.resolved]

    def _role(self, role: str) -> ParsedSegment | None:
        for s in self.segments:
            if s.role == role:
                return s
        return None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "raw": self.raw,
            "segments": [s.to_json() for s in self.segments],
            "fullyResolved": self.fully_resolved,
        }
        for role in ("fund", "department", "object", "project"):
            seg = self._role(role)
            if seg and seg.entry:
                out[role] = {"code": seg.raw, "name": seg.entry.name}
        if self.unresolved_codes:
            out["unresolved"] = self.unresolved_codes
        return out


# ----------------------------------------------------------------------
# Core parser
# ----------------------------------------------------------------------
def extract_segments(raw: str) -> list[str]:
    """Pull all digit runs from ``raw`` in left-to-right order.

    Whitespace, dots, hyphens, parentheses, and other punctuation are
    all valid separators in observed PDF text. Anything non-digit is
    treated as a delimiter.
    """
    return _DIGIT_RUN.findall(raw or "")


def _select_entry(
    candidates: list[CoAEntry],
    position: int,
) -> CoAEntry | None:
    """Pick a single CoAEntry from a list of candidates, using position bias."""
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    preferred = _POSITION_PREFERENCE.get(position, ())
    for role in preferred:
        for c in candidates:
            if _TREE_TO_ROLE.get(c.tree_name) == role:
                return c
    # Fallback: first candidate (deterministic — by_code list order from cache).
    return candidates[0]


def parse(
    raw: str,
    cache: dict[str, Any],
    *,
    drop_zero_project: bool = True,
) -> ParsedAccountCode:
    """Parse a raw account-code string and resolve each segment.

    Parameters
    ----------
    raw:
        The string as it appeared in the Summary Sheet (any separator).
    cache:
        A loaded CoA cache (from ``opengov.coa.load_cache``).
    drop_zero_project:
        When True (default) treat a trailing all-zero segment (e.g.
        ``0000000``) as "no project" and omit it from the parsed output
        entirely. Tampa's CoA does not have a node for an all-zero
        project; keeping it would just produce a spurious unresolved
        segment.
    """
    raw_segments = extract_segments(raw)

    if drop_zero_project and raw_segments and set(raw_segments[-1]) == {"0"}:
        raw_segments = raw_segments[:-1]

    parsed: list[ParsedSegment] = []
    for i, code in enumerate(raw_segments):
        candidates = lookup(cache, code)
        entry = _select_entry(candidates, position=i)
        role = _TREE_TO_ROLE.get(entry.tree_name) if entry else None
        parsed.append(
            ParsedSegment(
                position=i,
                raw=code,
                role=role,
                entry=entry,
                candidates=candidates,
            )
        )
    return ParsedAccountCode(raw=raw, segments=parsed)


# ----------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------
def _cli(argv: list[str] | None = None) -> int:
    import argparse
    import json
    from pathlib import Path

    from .coa import DEFAULT_CACHE_PATH, load_cache

    parser = argparse.ArgumentParser(
        prog="python3 -m opengov.parse_account_code",
        description="Parse a Tampa account-code string against the cached CoA.",
    )
    parser.add_argument(
        "codes",
        nargs="+",
        help="One or more raw account-code strings. Quote them if they contain spaces.",
    )
    parser.add_argument(
        "--cache-path",
        default=str(DEFAULT_CACHE_PATH),
        help=f"CoA cache file (default: {DEFAULT_CACHE_PATH})",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of human-readable text.",
    )
    args = parser.parse_args(argv)

    cache = load_cache(Path(args.cache_path))
    results = [parse(c, cache) for c in args.codes]

    if args.json:
        print(json.dumps([r.to_json() for r in results], indent=2))
        return 0 if all(r.fully_resolved for r in results) else 1

    exit_code = 0
    for r in results:
        marker = "OK " if r.fully_resolved else "?? "
        print(f"{marker}{r.raw}")
        for s in r.segments:
            if s.entry:
                amb = "  (ambiguous)" if len(s.candidates) > 1 else ""
                print(
                    f"     [{s.position}] {s.raw:>8}  {s.role or '-':>10}  "
                    f"{s.entry.tree_name:>14}  {s.entry.name}{amb}"
                )
            else:
                print(f"     [{s.position}] {s.raw:>8}  (unresolved)")
                exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(_cli())

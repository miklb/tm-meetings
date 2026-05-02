"""Render a compact funding-summary card from a funding manifest.

A *card* here means a small, scannable summary — not an exhaustive
report. The card surfaces the few numbers a reader actually wants:

- meeting headline and date
- net dollar impact (the single most important number)
- a handful of headline stats (item count, expenditures, decreases)
- top 3 funds by absolute net impact
- a collapsed `<details>` block for the full line-item list

Two output modes share the same data, just different markup:

- ``--format html`` — a standalone ``<article>`` card with embedded CSS
- ``--format wp``   — a WordPress block group with the same shape
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def _money(v: float | None, *, sign: bool = False, compact: bool = False) -> str:
    if v is None:
        return "—"
    if compact and abs(v) >= 1_000_000:
        s = f"${abs(v) / 1_000_000:.1f}M"
    elif compact and abs(v) >= 1_000:
        s = f"${abs(v) / 1_000:.0f}K"
    else:
        s = f"${abs(v):,.0f}"
    if sign:
        return ("+" if v >= 0 else "−") + s
    return s if v >= 0 else "−" + s


def _items_with_accounts(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in manifest.get("items", [])
        if any(d.get("accountCode") for d in item.get("details", []))
    ]


def _top_funds(summary: dict[str, Any], n: int = 3) -> list[tuple[str, dict[str, Any]]]:
    funds = list((summary.get("byFund") or {}).items())
    funds.sort(key=lambda kv: abs(kv[1].get("net") or 0), reverse=True)
    return funds[:n]


def _resolved_count(manifest: dict[str, Any]) -> int:
    return sum(
        1
        for item in manifest.get("items", [])
        for d in item.get("details", [])
        if d.get("accountCode")
    )


# ------------------------------------------------------------------
# Standalone HTML card
# ------------------------------------------------------------------
_CSS = """\
.og-card { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 480px; border: 1px solid #d0d7de; border-radius: 8px;
  padding: 1rem 1.25rem; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
.og-card__eyebrow { color: #57606a; font-size: .8rem; text-transform: uppercase;
  letter-spacing: .05em; margin: 0 0 .25rem; }
.og-card__title { font-size: 1.1rem; font-weight: 600; margin: 0 0 .75rem; }
.og-card__net { display: flex; align-items: baseline; gap: .5rem; margin: .5rem 0 1rem; }
.og-card__net-value { font-size: 1.75rem; font-weight: 700; }
.og-card__net--positive { color: #1a7f37; }
.og-card__net--negative { color: #cf222e; }
.og-card__net-label { color: #57606a; font-size: .85rem; }
.og-card__stats { display: grid; grid-template-columns: repeat(3, 1fr);
  gap: .5rem; margin-bottom: 1rem; }
.og-card__stat { background: #f6f8fa; border-radius: 6px; padding: .5rem .6rem; }
.og-card__stat-value { font-weight: 600; font-size: 1rem; display: block; }
.og-card__stat-label { color: #57606a; font-size: .75rem; }
.og-card__funds { margin: 0 0 1rem; padding: 0; list-style: none; font-size: .9rem; }
.og-card__funds li { display: flex; justify-content: space-between;
  padding: .25rem 0; border-bottom: 1px dotted #d0d7de; }
.og-card__funds li:last-child { border: 0; }
.og-card__details summary { cursor: pointer; color: #0969da; font-size: .85rem;
  padding: .25rem 0; }
.og-card__details table { width: 100%; border-collapse: collapse; font-size: .8rem;
  margin-top: .5rem; }
.og-card__details th, .og-card__details td { text-align: left;
  padding: .25rem .4rem; border-bottom: 1px solid #eaeef2; }
.og-card__details th { color: #57606a; font-weight: 500; }
.og-card__details td.num { text-align: right; font-variant-numeric: tabular-nums; }
.og-card__warning { color: #9a6700; font-size: .8rem; margin-top: .75rem;
  padding: .4rem .6rem; background: #fff8c5; border-radius: 6px; }
"""


def _line_items_table(items: list[dict[str, Any]]) -> str:
    rows = []
    for item in items:
        for d in item.get("details", []):
            if not d.get("accountCode"):
                continue
            enriched = d.get("enriched") or {}
            fund = (enriched.get("fund") or {}).get("name") or "—"
            dept = (enriched.get("department") or {}).get("name") or "—"
            rows.append(
                f"<tr><td>{item.get('fileNumber') or '—'}</td>"
                f"<td>{fund}</td><td>{dept}</td>"
                f"<td class='num'>{d.get('amount') or '—'}</td>"
                f"<td>{d.get('fiscalYear') or '—'}</td></tr>"
            )
    if not rows:
        return ""
    return (
        "<table><thead><tr><th>File</th><th>Fund</th><th>Dept</th>"
        "<th class='num'>Amount</th><th>FY</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def render_html(manifest: dict[str, Any]) -> str:
    summary = manifest.get("summary") or {}
    totals = summary.get("totals") or {}
    net = totals.get("net") or 0.0
    items = _items_with_accounts(manifest)
    resolved = _resolved_count(manifest)
    unresolved = summary.get("unresolvedCount") or 0
    top = _top_funds(summary, 3)

    funds_list = "".join(
        f"<li><span>{info.get('name') or code}</span>"
        f"<strong>{_money(info.get('net'), sign=True, compact=True)}</strong></li>"
        for code, info in top
    )

    net_class = "og-card__net--positive" if net >= 0 else "og-card__net--negative"
    warning = (
        f"<p class='og-card__warning'>⚠ {unresolved} account segment(s) unresolved</p>"
        if unresolved
        else ""
    )
    line_items = _line_items_table(items)
    details_block = (
        f"<details class='og-card__details'>"
        f"<summary>{resolved} line item{'s' if resolved != 1 else ''} →</summary>"
        f"{line_items}</details>"
        if line_items
        else ""
    )

    return f"""\
<style>{_CSS}</style>
<article class="og-card" data-meeting-id="{manifest.get('meetingId', '')}">
  <p class="og-card__eyebrow">{manifest.get('meetingType') or 'Council Meeting'} · {manifest.get('meetingDate', '')}</p>
  <h2 class="og-card__title">Funding Summary</h2>
  <div class="og-card__net {net_class}">
    <span class="og-card__net-value">{_money(net, sign=True, compact=True)}</span>
    <span class="og-card__net-label">net impact</span>
  </div>
  <div class="og-card__stats">
    <div class="og-card__stat">
      <span class="og-card__stat-value">{len(items)}</span>
      <span class="og-card__stat-label">items w/ funding</span>
    </div>
    <div class="og-card__stat">
      <span class="og-card__stat-value">{_money(totals.get('expenditures'), compact=True)}</span>
      <span class="og-card__stat-label">expenditures</span>
    </div>
    <div class="og-card__stat">
      <span class="og-card__stat-value">{_money(totals.get('decreases'), compact=True)}</span>
      <span class="og-card__stat-label">decreases</span>
    </div>
  </div>
  {f"<ul class='og-card__funds'>{funds_list}</ul>" if funds_list else ""}
  {details_block}
  {warning}
</article>
"""


# ------------------------------------------------------------------
# WordPress block card
# ------------------------------------------------------------------
def render_wp(manifest: dict[str, Any]) -> str:
    summary = manifest.get("summary") or {}
    totals = summary.get("totals") or {}
    net = totals.get("net") or 0.0
    items = _items_with_accounts(manifest)
    resolved = _resolved_count(manifest)
    unresolved = summary.get("unresolvedCount") or 0
    top = _top_funds(summary, 3)

    net_color = "#1a7f37" if net >= 0 else "#cf222e"
    net_str = _money(net, sign=True, compact=True)
    headline = (
        f"<strong style=\"color:{net_color};font-size:1.4em\">{net_str}</strong> net · "
        f"{len(items)} items · "
        f"{_money(totals.get('expenditures'), compact=True)} exp · "
        f"{_money(totals.get('decreases'), compact=True)} dec"
    )

    fund_items = "".join(
        f"<!-- wp:list-item --><li>{info.get('name') or code} — "
        f"<strong>{_money(info.get('net'), sign=True, compact=True)}</strong>"
        f"</li><!-- /wp:list-item -->"
        for code, info in top
    )
    funds_block = (
        "<!-- wp:list -->\n<ul class=\"wp-block-list\">"
        f"{fund_items}</ul>\n<!-- /wp:list -->"
        if fund_items
        else ""
    )

    rows = ""
    for item in items:
        for d in item.get("details", []):
            if not d.get("accountCode"):
                continue
            enriched = d.get("enriched") or {}
            fund = (enriched.get("fund") or {}).get("name") or "—"
            dept = (enriched.get("department") or {}).get("name") or "—"
            rows += (
                f"<tr><td>{item.get('fileNumber') or '—'}</td>"
                f"<td>{fund}</td><td>{dept}</td>"
                f"<td>{d.get('amount') or '—'}</td>"
                f"<td>{d.get('fiscalYear') or '—'}</td></tr>"
            )

    details_block = (
        "<!-- wp:html -->\n"
        f"<details class=\"og-funding-card__details\"><summary>"
        f"{resolved} line item{'s' if resolved != 1 else ''} →</summary>"
        "<table><thead><tr><th>File</th><th>Fund</th><th>Dept</th>"
        f"<th>Amount</th><th>FY</th></tr></thead><tbody>{rows}</tbody></table>"
        "</details>\n<!-- /wp:html -->"
        if rows
        else ""
    )

    warning_block = (
        "<!-- wp:paragraph {\"className\":\"og-funding-card__warning\"} -->\n"
        f"<p class=\"og-funding-card__warning\">⚠ {unresolved} account segment(s) unresolved</p>\n"
        "<!-- /wp:paragraph -->"
        if unresolved
        else ""
    )

    parts = [
        "<!-- wp:group {\"className\":\"og-funding-card\"} -->",
        "<div class=\"wp-block-group og-funding-card\">",
        "<!-- wp:heading {\"level\":4} -->",
        "<h4 class=\"wp-block-heading\">Funding Summary</h4>",
        "<!-- /wp:heading -->",
        "<!-- wp:paragraph -->",
        f"<p>{headline}</p>",
        "<!-- /wp:paragraph -->",
    ]
    if funds_block:
        parts.append(funds_block)
    if details_block:
        parts.append(details_block)
    if warning_block:
        parts.append(warning_block)
    parts.append("</div>")
    parts.append("<!-- /wp:group -->")
    return "\n".join(parts)


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------
def _cli(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python3 -m opengov.card",
        description="Render a compact funding-summary card from a manifest.",
    )
    parser.add_argument("manifest", help="Path to a funding-manifest JSON file.")
    parser.add_argument(
        "--format",
        choices=["html", "wp"],
        default="html",
        help="Output format (default: html).",
    )
    parser.add_argument("--out", help="Write to file instead of stdout.")
    args = parser.parse_args(argv)

    manifest = json.loads(Path(args.manifest).read_text())
    rendered = render_wp(manifest) if args.format == "wp" else render_html(manifest)

    if args.out:
        Path(args.out).write_text(rendered)
        print(f"wrote {args.out}")
    else:
        print(rendered)

    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())

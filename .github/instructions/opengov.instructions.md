---
applyTo: "{opengov/**,agenda-scraper/json-to-markdown.js,agenda-scraper/json-scraper.js}"
description: "OpenGov Budgeting & Performance integration — Summary Sheet financial reconciliation, CoA lookups, funding manifest + per-item rendering. USE WHEN: working in opengov/, modifying how Summary Sheet financial data is parsed/displayed, integrating funding data into the tm-static agenda output, or adding aggregate funding stats to an agenda."
---

## Purpose

The [opengov](opengov/) directory is a **separate Python tool** (Phase 5 implemented as of 2026-05-02) that joins regex-extracted Summary Sheet dollar amounts with the City's authoritative OpenGov chart of accounts (CoA). It enriches each `financialDetails[]` line on a scraped meeting with `fund` / `department` / `object` / `project` labels and a `fiscalYear`, then emits a per-meeting **funding manifest** that `json-to-markdown.js` renders into the agenda post.

It is **not** another scraper — it consumes JSON already produced by `agenda-scraper/json-scraper.js` (the `agendaItems[].financialDetails[]` array).

## Architecture in two sentences

1. `opengov/coa.py` caches the ~2,900-node CoA tree from the public, unauthenticated `reporting.opengov.com` package endpoint into [opengov/data/coa-cache.json](opengov/data/coa-cache.json).
2. `opengov/reconcile.py` extracts account codes (5.6.6 or 5.6.6.7 with `.`/`-`/space separators) from each detail's `contexts[]`, resolves segments via the cache, aggregates by fund/department, and writes `opengov/data/reports/<meetingId>-<formattedDate>-funding-manifest.json`. `agenda-scraper/json-to-markdown.js` reads that manifest and renders per-item funding sections plus an agenda-level overview.

See [opengov/PLAN.md](opengov/PLAN.md), [opengov/README.md](opengov/README.md), and [opengov/ACCOUNT_CODES.md](opengov/ACCOUNT_CODES.md) for the full spec.

## Environment — IMPORTANT

The opengov tool has its **own** venv at the repo-root `.venv/` (separate from the pipeline venv at `transcript-cleaner/processor/venv/`). The only dep is `httpx`.

```bash
# correct
source .venv/bin/activate
python3 -m opengov.reconcile agenda-scraper/data/meeting_2564_2026-01-08.json

# wrong — pipeline venv does not have opengov module installed for module imports
source pipeline/activate.sh && python3 -m opengov.reconcile ...
```

Run from the repo root so the package import path `-m opengov.X` resolves.

## CLI surface

| Command | Purpose |
| --- | --- |
| `python3 -m opengov.coa refresh` | Force-refresh the CoA cache from the public endpoint. |
| `python3 -m opengov.parse_account_code "01100.232900.531003"` | Resolve a raw code to segment labels — debugging aid. |
| `python3 -m opengov.reconcile <meeting.json> [--out-dir opengov/data/reports/]` | Build a funding manifest. |

## Manifest schema (read this before designing a UI)

Funding manifest top-level shape (see [opengov/data/reports/2564-2026-01-08-funding-manifest.json](opengov/data/reports/2564-2026-01-08-funding-manifest.json) for a real example):

```jsonc
{
  "meetingId": "2564",
  "meetingDate": "January 8, 2026",
  "formattedDate": "2026-01-08",
  "items": [
    {
      "agendaItemId": "19782",         // joins back to scraper agenda items
      "itemNumber": 5,
      "fileNumber": "PS26-19782",
      "title": "...",
      "rows": [ /* enriched financialDetails */ ],
      "totals": { "expenditures": ..., "decreases": ..., "revenues": ..., "net": ... }
    }
  ],
  "summary": {
    "byFund":       { "<fundCode>": { "name": "...", "net": ... } },
    "byDepartment": { "<deptCode>": { "name": "...", "net": ... } },
    "totals":       { "expenditures": ..., "decreases": ..., "revenues": ..., "net": ... },
    "unresolvedCount": 2
  }
}
```

Each enriched `rows[]` entry adds: `accountCode`, `fiscalYear`, `enriched.{fund,department,object,project}`, `unresolved[]`. When no account code is found in any context, `accountCode` is `null` and `enriched` is `null` — the line is still kept (its `value` rolls into `totals.other`).

## Integration goal (per Mikl, 2026-05-02)

The end goal is to surface this data in the rendered agendas. This **is built**: `agenda-scraper/json-to-markdown.js` imports `loadFundingManifest` / `buildFundingByItemId` from `lib/render-funding` (around line 33-37) and renders per-item funding sections plus an agenda-level overview (around line 643-647). Constraints that still apply when extending it:

- **Per-item integration belongs with the agenda item it funds.** Match line items to agenda items by `agendaItemId` (not `itemNumber`, which is only positional).
- **Aggregate data for the whole agenda is wanted** (top-of-page summary). The `summary` block in the manifest is the starting point.
- **Plain line-item lists without an agenda item number add no value.** Any per-item rendering must associate each line with the agenda item it funds (file number + title), not show a flat unattributed table.
- **Unresolved codes matter.** `summary.unresolvedCount > 0` should surface visibly; an unresolved segment usually means a typo in the PDF or a new account not in the cached CoA (refresh with `python3 -m opengov.coa refresh`).

## Pipeline order

When wiring this into the build, the order is fixed:

```
1. agenda-scraper/json-scraper.js   →  agenda-scraper/data/meeting_<ID>_<date>.json
2. opengov/reconcile.py             →  opengov/data/reports/<ID>-<date>-funding-manifest.json
3. agenda-scraper/json-to-markdown.js (reads the manifest)
                                    →  tm-static Markdown post
```

`process-agenda.sh` runs this chain in order — see the Critical Rules in the repo root `CLAUDE.md`.

## Things that have NOT been built yet

- **Aggregate `select` endpoint amounts.** The `POST /api/transparency/v1/select/{coa_id}` body shape has been captured and solved (see PLAN.md "Aggregated amounts"), but the amounts-querying client lives in a separate private research toolkit, not in this repo. Variance/over-appropriation flags remain unbuilt here. Note the endpoint serves budget-book datasets (budgets, actuals, projections) — not encumbrances or PO-level obligation data.
- **Fiscal-year ledger** (Phase 5.2) — not started.

## CoA cache hygiene

The cache is gitignored. If `unresolvedCount` spikes after a fresh agenda, refresh the cache before assuming a parser bug:

```bash
source .venv/bin/activate
python3 -m opengov.coa refresh
```

Cache validity is checked via the package response's `cache_key` plus per-dataset `etag` — see `opengov/coa.py`.

## Account code parsing notes

Tampa codes are pure digits with widths `5.6.6.7` (project optional) and any of `.`, `-`, ` ` as separators. The parser tolerates whitespace artifacts from `pdfplumber` extraction. Trailing all-zero project segments (`0000000`) are dropped before lookup. 11 codes collide between Departments and Liabilities trees — position is the tie-breaker. Full edge cases in [opengov/ACCOUNT_CODES.md](opengov/ACCOUNT_CODES.md).

# Implementation Plan

## Goals

1. Resolve every account-code string parsed from Tampa Summary Sheets to
   a canonical OpenGov chart-of-accounts entry.
2. Produce a per-agenda **funding manifest** that totals the money asks
   correctly (something the regex-only approach gets wrong today).
3. Produce a **fiscal-year ledger** of all Council-approved appropriations,
   joinable by fund / department / project for transparency reporting.
4. Flag discrepancies between Summary-Sheet amounts and OpenGov budget
   line items (over-appropriation, missing accounts, typos in PDFs).

## Discovered API surface (verified 2026-05-02)

The Tampa Transparency SPA at `tampa.opengov.com` is backed by the
unauthenticated `reporting.opengov.com` host. Probes in
[scripts/](scripts/) confirm the following endpoints work without any
API key. All identifiers below are real Tampa values.

### Chart-of-accounts retrieval (the critical piece)

```
POST https://reporting.opengov.com/api/transparency/v1/package/{coa_id}
Content-Type: application/json
Body: {
  "coa_mask_id":  <int from report.coa_mask_id>,
  "data_sets":    [<dataset_uuid>, ...],
  "mask":         null,
  "serve_old":    true,
  "state_scale":  false,
  "ungroup":      null,
  "api":          null
}
```

Response (~1.2 MB for FY2026):

| Field       | Contents                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `nodes`     | Dict of ~2,900 CoA nodes keyed by UUID. Each leaf has `account_codes: ["01100"]` and `name: "General Fund"`.                               |
| `trees`     | Multiple breakdown trees (`expenses`, `revenues`, `assets`, `liabilities`, plus per-breakdown UUIDs for Fund Group / Dept / Account Type). |
| `data_sets` | Per-dataset metadata (year, type, etag).                                                                                                   |
| `cache_key` | Server cache key — useful for change detection.                                                                                            |

This single call returns **every account code Tampa uses** with its
human label, organized into the same hierarchy users see in the
Transparency dashboard. It is sufficient to resolve any
`Fund.Department.Object.Project` string from a Summary Sheet.

### Supporting metadata endpoints (GET, no auth)

| Endpoint                          | Use                                                         |
| --------------------------------- | ----------------------------------------------------------- |
| `GET /api/v1/entities/tampa`      | Resolve `entity_id` (3258), `entity_uuid`, `default_coa_id` |
| `GET /api/v1/reports/{report_id}` | Get `data_sets[]`, `coa_id`, `coa_mask_id`                  |
| `GET /api/v1/data_sets/{ds_id}`   | Per-dataset `etag` for change detection                     |

### Aggregated amounts (POST, no auth — body shape solved)

```
POST https://reporting.opengov.com/api/transparency/v1/select/{coa_id}
```

Returns `amounts` (in cents) keyed
`amounts[account_type][node_id][data_set_id]` for the requested
`checked_nodes`. The body shape was captured from the SPA and verified
working; the querying client lives in a separate private research
toolkit, not this repo. Key gotchas — the endpoint never errors, it
returns 200 with empty `amounts` when the request is wrong:

- `cache_key` must echo the value from the matching `package` response.
- `checked_nodes` must include the depth-0 roots of the account-type
  trees (`expenses` etc.) in addition to the breakdown nodes you want.
- `breakdown` is a tree UUID, except account-type category breakdowns
  which use the literal sentinel string `types`.
- A multi-root tree (e.g. Funds: Governmental / Proprietary / Fiduciary)
  needs one request per root — a single combined request silently drops
  roots.

Scope note: datasets are budget books (adopted/revised budgets, settled
actuals, in-year projections) — **not** encumbrances or transaction-level
obligation data.

### Out of scope for v1

- `POST /api/transactions/v1/query/{transaction_id}` — individual
  transaction rows. Likely requires auth and a `transaction_id` we can
  only obtain through the SPA's session bootstrap. Not needed for
  Council-agenda reconciliation.
- `api.bnp.opengov.com` (the new JSON:API product). Nice-to-have for
  real-time amendments; not required for v1.

## Verified Tampa identifiers

| Field                      | Value                                  |
| -------------------------- | -------------------------------------- |
| Entity slug                | `tampa`                                |
| Entity ID (int)            | `3258`                                 |
| Entity UUID                | `eb3265cf-3e21-4417-8e3c-04fbfdcfc1d1` |
| Default CoA UUID           | `c8d0e77d-a56d-4355-8042-d85c1b5f9a7c` |
| FY2026 Total Budget report | `145174`                               |
| FY2026 Recommended dataset | `92037640-2a64-4f32-9c7b-de42b7842274` |
| FY2026 `coa_mask_id`       | `5482`                                 |

Other useful report IDs (from the transparency portal homepage):

- FY2026 Operating Budget: `145207`
- FY2026 Capital Budget (Five Year): `145209`
- FY2026 Fund Level Forecast: `145208`
- FY2025 Total Budget: `116209`
- FY2024 Total Budget: `72161`
- FY2023 Total Budget: `64697`

## Phases

### Phase 1 — `client.py`

Thin wrapper over the four endpoints listed above. No auth, just
`httpx.Client` with a sane timeout, retry on 5xx, and a tiny on-disk
ETag cache to avoid re-downloading the same package.

### Phase 2 — `coa.py` cache

Call `package` once, flatten `nodes` into a lookup table:

```python
{
  "01100":   {"id": "...", "name": "General Fund",          "tree": "fund",  "depth": 2, "parent": "..."},
  "243200":  {"id": "...", "name": "Wastewater Department", "tree": "dept",  ...},
  "563001":  {"id": "...", "name": "Improvements Other than Buildings", "tree": "object", ...},
  "1001574": {"id": "...", "name": "Virginia Pumping Station Rehab",    "tree": "project", ...},
}
```

Persist to `data/coa-cache.json`. Refresh when the package response's
`cache_key` changes (cheap: just `GET /api/v1/data_sets/{id}` for the
latest dataset and compare `etag`).

### Phase 3 — `parse_account_code.py` ✅

Normalize observed Tampa formats (see [ACCOUNT_CODES.md](ACCOUNT_CODES.md))
into a list of segment strings. Each segment is then looked up
independently in the CoA cache — segments live in different breakdown
trees (Fund tree, Department tree, etc.), so a 4-segment code yields
4 independent lookups.

**Implemented.** `extract_segments()` pulls digit runs out of any
delimiter style; `parse()` resolves each run via `coa.lookup()` and
slots it into `fund` / `department` / `object` / `project` based on
which tree the CoA cache returns. Position is used as a tie-breaker
for the 11 codes that collide between Departments and Liabilities.
Trailing all-zero project segments (`0000000`) are dropped before
lookup. CLI: `python3 -m opengov.parse_account_code "<raw>"`.

> **Resolved: `select` endpoint amounts spike.** Implementing
> `parse_account_code.py` did **not** require resolving how to fetch
> dollar amounts per node — Phase 3 only needed the CoA structure
> (already supplied by `coa.py`). The `select` body shape has since been
> captured and verified (see "Aggregated amounts" above). Variance /
> over-appropriation flags are still unbuilt in this repo; the amounts
> client lives in a separate private research toolkit.

### Phase 4 — `reconcile.py` ✅

Consume agenda JSON from `agenda-scraper/data/`
and enrich each `details[]` line with:

```json
{
  "amount": "$95,050.40",
  "type": "expenditure_decrease",
  "value": -95050.4,
  "accountCode": "41153.243200.563001.1001574",
  "enriched": {
    "fund": {
      "code": "41153",
      "name": "Wastewater Bonds – Series 2024 Capital Projects Fund"
    },
    "department": { "code": "243200", "name": "Wastewater Department" },
    "object": { "code": "563001", "name": "Improvements Other than Buildings" },
    "project": {
      "code": "1001574",
      "name": "Virginia Pumping Station Rehab Project"
    },
    "fiscalYear": 2026
  }
}
```

Then aggregate per agenda by Fund / Department / FY. Flag any line
whose code didn't resolve (typo in PDF, or new account not yet in the
cached CoA — triggers a refresh).

### Phase 5 — Reporting

1. **Per-agenda card** ✅ — `opengov/card.py` renders both standalone HTML
   and WordPress block markup from a funding manifest. See
   `opengov/WP_INTEGRATION.md` for how to insert cards into the
   `json-to-wordpress.js` pipeline.
2. **Fiscal-year ledger** — append-only JSONL of approved
   appropriations, with a small dashboard (sortable table + sparkline).

## Environment

- Python 3.10+ in `.venv` (repo convention)
- `httpx` only — no JSON:API client needed for the public endpoints
- No DB — JSON cache + JSONL ledger are sufficient

## Probe scripts

- `scripts/probe_reporting_api.py` — initial endpoint discovery
- `scripts/probe_spa_endpoints.py` — second-pass after reading the SPA bundle
- `scripts/probe_tapi.py` — transparency / transactions API probes
- `scripts/probe_package.py` — the working package-endpoint call

Run any of them with `python3 opengov/scripts/<name>.py` from the repo
root. They are read-only and safe.

## Open questions

- Does the `select` endpoint return amounts when called with the right
  body shape? (Originally tagged "Phase 3 spike" — moved: now blocks
  Phase 4 variance reporting, not Phase 3 parsing.)
- Procurement / contracts enrichment via
  `api.procurement.opengov.com/gateway/datasets/v1/contracts` — separate
  phase, only if contract IDs end up worth joining to agenda items.
- Grant-funded accounts that live outside the default CoA — need to
  detect and call `package` for additional `coa_id`s.

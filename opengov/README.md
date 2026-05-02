# opengov — OpenGov Budgeting & Performance Integration

Local-transparency tooling that reconciles the dollar amounts and account
codes ("buckets") referenced in Tampa City Council Summary Sheets with the
authoritative records in the City's OpenGov Budgeting & Performance system.

> **Status:** Phase 0 complete. Public Tampa CoA (~2,900 nodes, 2,799
> with account codes) is reachable unauthenticated via the
> Transparency package endpoint — see [PLAN.md](PLAN.md). No production
> code yet; only probe scripts in [scripts/](scripts/).
>
> **No API key needed for v1.** The original plan to request an OpenGov
> Budgeting & Performance API key is on hold — the public
> `reporting.opengov.com` endpoints supply everything required for
> Summary-Sheet reconciliation.

## Why

The `agenda-scraper/` pipeline already extracts dollar amounts
from Summary Sheet PDFs (`agenda-scraper/json-scraper.js` →
`extractDollarAmounts`). That extraction is regex-based and brittle:

- mis-categorizes increase / decrease / final-payment line items
- silently drops amounts when fiscal-year footnotes wrap onto new lines
- has no way to validate the account string (e.g. `41153.243200.563001.1001574`)
  against the City's actual chart of accounts
- cannot roll up totals by Fund / Department / Project across an agenda
  or across a fiscal year

OpenGov's Budgeting & Performance API exposes the canonical chart of
accounts and the budget amounts associated with every account number.
Joining the two unlocks:

| Reporter use case                                   | Today                       | With OpenGov join                                         |
| --------------------------------------------------- | --------------------------- | --------------------------------------------------------- |
| "How much did Council approve this week?"           | Sum of regex-parsed dollars | Sum validated against budget line items                   |
| "What fund / department is this coming from?"       | Inferred from prose         | Resolved from CoA segment labels                          |
| "Is this within the appropriated budget?"           | Unknown                     | Compare item amount vs. `budget-amounts` for that account |
| "Show me every Wastewater Bonds 2024 item"          | Manual prose search         | Filter by Fund segment `41153`                            |
| "Year-to-date Council appropriations by department" | Not possible                | Aggregate by Department segment across agendas            |

## What this directory will contain

```
opengov/
├── README.md              # this file
├── PLAN.md                # implementation plan
├── ACCOUNT_CODES.md       # Tampa CoA format notes
├── requirements.txt       # python deps (httpx, pydantic)
├── .env.example           # OPENGOV_API_KEY, OPENGOV_ENTITY_ID
├── client.py              # thin BNP API client (Token auth)
├── coa.py                 # chart-of-accounts fetch + cache
├── reconcile.py           # join Summary Sheet line items ↔ CoA accounts
├── parse_account_code.py  # parse "41153.243200.563001.1001574" → segments
├── cli.py                 # `python -m opengov reconcile <agenda.json>`
├── data/
│   ├── coa-cache.json     # gitignored; refreshed weekly
│   └── reports/           # generated transparency reports
└── tests/
```

## Boundaries with the agenda-scraper

This directory **does not** re-parse PDFs. It consumes JSON output already
produced by `agenda-scraper/` (the `details[]` array from
`extractDollarAmounts`) and enriches each line item with:

- `accountId` (UUID) resolved from the parsed account-code string
- `fund`, `department`, `object`, `project` labels
- `budgetAmount` for the matching fiscal year
- `budgetVarianceAfterApproval` (running total)

The enrichment flows back into `agenda-scraper/json-to-wordpress.js` as a
post-processing step, or can be published independently as a weekly
transparency dataset.

## Data sources

OpenGov runs **two** APIs that are relevant here. We can do almost
everything with the unauthenticated one.

### 1. Public reporting API — `reporting.opengov.com` (no auth) — primary

This is the API behind every City of Tampa Transparency dashboard at
`tampa.opengov.com`. It is open to the public and stable.

Verified Tampa identifiers:

| Field                          | Value                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Entity ID (legacy int)         | `3258`                                                                                     |
| Entity UUID                    | `eb3265cf-3e21-4417-8e3c-04fbfdcfc1d1`                                                     |
| Default Chart of Accounts UUID | `c8d0e77d-a56d-4355-8042-d85c1b5f9a7c`                                                     |
| Transparency portal            | https://tampa.opengov.com/                                                                 |
| Stories (annual budget book)   | https://stories.opengov.com/tampa/f9ac8a22-1024-454b-bb87-f5f980e98715/published/4rwPtXRZO |
| FY2026 Total Budget report     | https://tampa.opengov.com/transparency/#/145174                                            |

Known working endpoints (HTTP GET, no headers required):

- `https://reporting.opengov.com/api/v1/entities/tampa` — entity metadata
- `https://reporting.opengov.com/api/v1/reports/{reportId}` — report
  metadata, including dataset IDs and `data_updated_at`

This tier is sufficient to: resolve account-code segments to human
labels, retrieve adopted and revised budget totals per fiscal year, and
validate Summary-Sheet line items. It will be the default backend.

### 2. Budgeting & Performance API — `api.bnp.opengov.com` (Token auth) — optional

This is the newer, JSON:API-flavored product API. It requires a
per-entity API key generated by City staff from the B&P Control Panel
and sent as `Token: <key>` header.

A key is **nice to have, not required**. It would unlock:

- real-time budget amendments (mid-year transfers and amendments before
  they appear in a published transparency report)
- programmatic access to in-progress / draft budgets
- a cleaner, documented JSON:API contract

Mikl has not requested a key yet; the request, if filed, should
specifically name the **Budgeting & Performance** product (not "OpenGov
in general") because keys are issued per product suite.

See [PLAN.md](PLAN.md) for the implementation order: build everything on
the public reporting API first, treat BNP as a later upgrade.

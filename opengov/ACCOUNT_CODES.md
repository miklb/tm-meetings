# Tampa Account-Code Notes

Observations from `agenda-scraper/` test fixtures and
real Summary Sheet PDFs.

## Canonical formats seen

| Example                       | Segments | Separator | Source                                             |
| ----------------------------- | -------- | --------- | -------------------------------------------------- |
| `41153.243200.563001.1001574` | 4        | `.`       | Wastewater Bonds Series 2024 Capital Projects Fund |
| `01100 232900 534007`         | 3        | space     | General Fund / Police / Other-Contractual Services |
| `01100-232900-534007-0000000` | 4        | `-`       | Same as above with explicit project=0000000        |

OpenGov's `chart-of-accounts` resource declares its valid separators
explicitly (`accountNumberSeparators: ["-", "."]`), so the parser can
normalize freely without losing information.

## Inferred segment meaning

From cross-referencing prose in Summary Sheets with the segment values:

| Position | Width | Label (Tampa)        | Example value | Example label                                        |
| -------- | ----- | -------------------- | ------------- | ---------------------------------------------------- |
| 1        | 5     | **Fund**             | `41153`       | Wastewater Bonds – Series 2024 Capital Projects Fund |
| 1        | 5     | **Fund**             | `01100`       | General Fund                                         |
| 2        | 6     | **Department**       | `243200`      | Wastewater Department                                |
| 2        | 6     | **Department**       | `232900`      | Police Dept                                          |
| 3        | 6     | **Object / Account** | `563001`      | Improvements Other than Buildings                    |
| 3        | 6     | **Object / Account** | `534007`      | Other – Contractual Services                         |
| 4        | 7     | **Project / Sub**    | `1001574`     | Virginia Pumping Station Rehabilitation Project      |
| 4        | 7     | **Project / Sub**    | `0000000`     | (no project — operating expense)                     |

**Caveat:** these are inferred. The authoritative segment labels come
from the `chart-of-accounts/{coaId}` endpoint's `segments[].label` field
(and the order in which segments are declared). Do not hard-code these;
read them from the API response and use them as labels.

## Edge cases to handle

1. **PDF text-extraction whitespace.** `pdfplumber` sometimes inserts
   non-breaking spaces or tabs between segments. Normalize all
   whitespace runs to a single space before parsing.
2. **Multiple line items per Summary Sheet.** The
   `extractDollarAmounts` parser already returns `details[]`; each
   detail has its own `accountCode` once we add that field.
3. **Annotated amounts.** Phrases like `(Expenditure Decrease)`,
   `(Revenue)`, `(Encumbrance)`, `Subject to annual appropriation`,
   `FY 2025` follow the dollar amount and qualify it. Capture these
   as flags on the line item, not by mutating the value.
4. **Final-payment + change order.** A single agenda item commonly has
   both a decrease (close out remaining encumbrance) and a final
   payment expenditure on the _same_ account in the _same_ FY. Net
   them only at the report layer; preserve both raw lines in the
   reconciled output.
5. **Truncated codes.** Some PDFs print `01100 232900 534007` with
   no project segment. Treat the missing trailing segment as the
   CoA's `defaultSegmentCode` (e.g. `0000000`) before lookup.
6. **Multi-year items.** Same account, two FYs, two amounts — emit
   one line per (account, FY) pair.

## Parsing strategy

```python
# parse_account_code.py — pseudocode
SEGMENT_RE = re.compile(r"\d{3,7}")  # all observed segments are pure digits
def parse(raw: str, coa_separators: list[str], coa_widths: list[int]) -> str:
    # 1. extract all digit runs in order
    parts = SEGMENT_RE.findall(raw)
    # 2. validate widths against coa_widths (pad with default for missing trailing segments)
    parts = pad_or_validate(parts, coa_widths)
    # 3. rejoin with the CoA's primary separator
    return coa_separators[0].join(parts)
```

The CoA's declared widths and separators come from the `segments[]`
array on the `chart-of-accounts` resource — fetch once, cache, reuse.

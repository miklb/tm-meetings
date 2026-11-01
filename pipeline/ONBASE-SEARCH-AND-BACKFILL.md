# OnBase date search and gap backfill: notes and prompts

_Written 2026-10-29 from a research session in `~/tampa-monitor`. Everything
under "Verified" was tested by hand that day with curl. Nothing here has been
built yet._

## Why

`meetings.db` has a hole from 2023-01-20 to 2025-07-16. Research keeps landing
in it (FY24 budget hearings, the 2024 CIT special call), and each time the
meetings get found by hand: probing OnBase ids, paging the CTTV grid. Two
goals:

1. A utility that does what the OnBase UI search does: a date range in, a list
   of meetings (OnBase id, type, start time) out.
2. Use it to backfill the gap into the archive, in batches, the same way the
   2025 backfill went (`docs/plans/backfill-2025-checklist.md`).

## Verified

### OnBase custom date-range search

The UI search at `https://tampagov.hylandcloud.com/251agendaonline/Meetings`
is a plain form post with an anti-forgery token.

1. `GET /251agendaonline/Meetings` with a cookie jar. Read the
   `__RequestVerificationToken` hidden input inside `form#searchForm`. The page
   has a second token in `#getMoreResultsForm`; use the search form's.
2. `POST /251agendaonline/Meetings` (same cookies) with form fields:

   | Field | Value |
   |---|---|
   | `__RequestVerificationToken` | from step 1 |
   | `Keywords` | empty |
   | `MeetingTypeIDs` | `103,104,105,106,107,108` (**one comma-separated value**) |
   | `DateRangeOptionID` | `11` (Custom Date Range) |
   | `DateRangeCustomStartDate` | `MM/DD/YYYY` |
   | `DateRangeCustomEndDate` | `MM/DD/YYYY` |

   Sending `MeetingTypeIDs` as repeated fields silently keeps only the first id.
   The echoed state shows it: `"MeetingTypeIDs":"103"` vs.
   `"MeetingTypeIDs":"103,104,105,106,107,108"`.

3. Results are JSON embedded in the response page (no separate API call):

   ```
   showSearchResults(new SearchResults({"MeetingTypes":[...],"MeetingTypeIDs":"103,...",
     "DateRangeOptionID":11,"DateRangeCustomStartDate":"2023-09-01T00:00:00",
     "DateRangeCustomEndDate":"2023-09-30T23:59:59",
     "Meetings":[{"ID":2103,"Name":"Council Special","MeetingTypeName":"Council Special",
       "IsAgendaAvailable":true,"IsSummaryAvailable":true,"IsMinutesAvailable":false,
       "Time":"2023-09-05T17:01:00-04:00", ...}, ...]}))
   ```

   Extract the object passed to `new SearchResults(...)` and parse it. Use
   `Time` for the date: older meeting `Name`s carry no date ("Council Special"),
   newer ones do ("City Council Regular - July 17, 2025").

Meeting type ids (from the form's multi-select):

| id | MeetingTypeName | pipeline `meeting_type` |
|---|---|---|
| 101 | Code Enforcement | (skip) |
| 102 | Council Calendar | (skip) |
| 103 | Council Evening | `evening` |
| 104 | Council Regular | `regular` (addenda come back as separate meetings, e.g. "Council Regular Addendum") |
| 105 | Council Special | `special` (budget hearings and special-call workshops land here) |
| 106 | Council Workshop | `workshop` |
| 107 | CRA Regular | `cra` |
| 108 | CRA Special | `cra`? Check how the pipeline types these. |

Other `DateRangeOptionID` values: 1 Last Year, 2 Last Month, 3 Last Week,
4 Recent/Upcoming (the landing default), 5 This Week, 6 This Month, 7 This
Year, 8 Next Week, 9 Next Month, 10 Next Year.

OnBase ids follow creation order, **not** meeting date. September 2023 alone
spans 1533 to 2331, so id probing is a fallback at best. The landing page
ignores GET date params.

**Test fixture: Sept. 1-30, 2023, types 103-108** (11 meetings):

| Time | ID | Name |
|---|---|---|
| 2023-09-05 17:01 | 2103 | Council Special (FY24 1st budget hearing) |
| 2023-09-07 09:00 | 1820 | Council Regular |
| 2023-09-07 09:00 | 2021 | Council Regular Addendum |
| 2023-09-13 15:00 | 2121 | Council Special (FY24 budget workshop) |
| 2023-09-14 09:00 | 2331 | CRA Regular |
| 2023-09-14 17:01 | 1533 | Council Evening |
| 2023-09-19 17:01 | 2128 | Council Special (FY24 final budget hearing) |
| 2023-09-21 09:00 | 1819 | Council Regular |
| 2023-09-21 09:00 | 2022 | Council Regular Addendum |
| 2023-09-28 09:00 | 2217 | Council Workshop |
| 2023-09-28 17:01 | 1534 | Council Evening |

### CTTV transcripts open directly by pkey

`https://apps.tampagov.net/cttv_cc_webapp/Agenda.aspx?pkey=<N>` returns the full
transcript page for old meetings (2495 was 1.9 MB). No RadGrid paging needed to
reach 2023. `transcript_lookup.py --pages N` still works for listing, but
direct fetch by pkey is simpler for a backfill.

Pkeys run **roughly** in date order but not strictly, and in 2023 there can be
more than one pkey per date:

| pkey | First date string on page | Notes |
|---|---|---|
| 2495 | 8/31/2023 | workshop |
| 2496 | AUGUST 31, 2023 | second 8/31 meeting? |
| 2497 | AUGUST 31, 2023 | third 8/31 meeting? |
| 2498 | SEPTEMBER 5, 2023 | budget hearing (OnBase 2103) |
| 2499 | SEPTEMBER 7, 2023 | regular (OnBase 1820) |
| 2500 | SEPTEMBER 13, 2023 | budget workshop (OnBase 2121) |
| 2501 | SEPTEMBER 19, 2023 | final budget hearing (OnBase 2128) |
| 2502 | SEPTEMBER 14, 2023 | out of order; evening and/or CRA |
| 2713 | (newest on the index, 2026-10-29) | |

The "first date string on the page" heuristic is good enough for a first pass
but not for matching. Read the page's own title/header for date and meeting
name before pairing a pkey with an OnBase id, and expect several-to-one in
both directions. Speaker turns look like
`<a class="ts-link" href="#t075143PM">...07:51:43PM >></a><b>MARTIN SHELBY</b>: ...`.

## Existing pieces to build on

- `agenda-scraper/process-agenda.sh --id <onbase id>`: scrape a specific
  historical meeting (commit `5f2c5c1`). `--type` keeps the type from being
  demoted to `regular` on historical re-scrapes (`77745a6`, code-review item 7
  in `docs/plans/CODE-REVIEW-2026-09-03.md`).
- `pipeline/archive-meeting.sh <pkey> <date> [--pages N] [--skip-video] [--skip-site]`.
- `pipeline/transcript_lookup.py` / `pipeline/discover.py`: CTTV index scrape
  and the `(date, meeting_type)` match to the db.
- `docs/plans/backfill-2025-checklist.md`: the checklist format the 2025
  backfill used. It says it was "generated from the OnBase search index
  (mtids 103-108)," but no script for that is committed. That's the gap this
  closes.
- Stub transcript-only meetings 1002435-1002450 (2022-11 to 2023-01,
  IMPLEMENTATION_PLAN.md "Unmatched historical transcripts"): the search can
  now find their OnBase agendas.

## Open questions before a big backfill

1. **Agenda format before the SIRE → OnBase migration (fall 2023).** Older
   meetings were migrated into OnBase. Does `json-scraper.js` parse them, and do
   supporting documents download? Test one meeting first (OnBase 1820,
   2023-09-07 regular).
2. **Addenda as separate OnBase meetings.** The 2025 backfill handled these
   ("In DB: —" rows). Keep the same treatment.
3. **Transcript ↔ agenda matching** when a date has several pkeys and several
   OnBase meetings (see 2023-08-31, 2023-09-14).
4. **Video.** YouTube ids and Whisper offset sync for 2023-2024. `--skip-video`
   first, video as a second pass?
5. **Volume and cost.** About 2½ years ≈ 200 OnBase meetings and 150+
   transcripts. IMPLEMENTATION_PLAN.md estimates 25-37 GB of documents in R2.
6. **Politeness.** Batch by month with pauses. No retry storms against OnBase
   or CTTV.
7. **Nightly CI** must not pick up historical meeting files as "changes."
8. **Agenda posts.** Historical meetings probably shouldn't generate tm-static
   agenda posts. Check what `process-agenda.sh` does for past dates.

## Suggested prompts (for a session opened inside `meetings/`)

**1. Build the search utility**

> Read CLAUDE.md, .github/copilot-instructions.md, the cli-scripts and
> python-environment instructions, and pipeline/ONBASE-SEARCH-AND-BACKFILL.md.
> Build `pipeline/onbase_search.py`: given `--start` and `--end` (YYYY-MM-DD)
> and optional `--types` (default 103-108), run the OnBase custom date-range
> search described in the notes and print one row per meeting (date, time,
> OnBase id, MeetingTypeName, mapped pipeline meeting_type, name). Support
> `--json`. Split long ranges into month-sized requests and merge. Add a test
> using the Sept 2023 fixture in the notes (synthetic HTML with the embedded
> `SearchResults` JSON, no network in tests).

**2. Resolve transcript pkeys for a date range**

> Add a way to find CTTV transcript pkeys by date without paging the grid:
> fetch `Agenda.aspx?pkey=N` directly, read the meeting date and title from the
> page header, and walk pkeys outward from a known anchor (2498 = 2023-09-05)
> until the requested range is covered. Cache pkey → (date, title) in a small
> JSON under `data/` so we never fetch the same pkey twice. Pkeys aren't
> strictly date-ordered (2502 = 2023-09-14), so walk a margin past each end.

**3. Prove one historical meeting end to end**

> Using the two tools, archive the 2023-09-07 regular meeting (OnBase 1820,
> addendum 2021, transcript pkey 2499) with `--skip-video` and no site deploy.
> Report what broke: agenda parse, document mirror, reconcile, db build,
> matching. Don't generate a tm-static agenda post for it. Fix only what's
> needed for the older format, then stop and summarize before any batch run.

**4. Generate the gap checklist and run batches**

> Generate `docs/plans/backfill-2023-2025-checklist.md` in the same format as
> `backfill-2025-checklist.md` for 2023-01-20 to 2025-07-16 (OnBase search +
> pkey cache). Then process one month at a time with `--skip-video`, rebuilding
> the db once per batch, and update the checklist as you go. Pause after each
> month for me to spot-check.

# Tampa City Council Agenda Scraper v3.0

A Node.js application that scrapes Tampa City Council agendas, stores them as structured JSON, and generates Markdown posts for the tm-static site with enhanced navigation and formatting.

## 🆕 Version 3.0 Features

### **HTTP-First Architecture**

- **Lightning Fast**: HTTP scraping is 3-5x faster than browser automation (~2 minutes vs ~5-10 minutes for 76 items)
- **No Browser Required**: No ChromeDriver/Selenium dependency — HTTP-only scraping
- **Parallel Processing**: Concurrent item fetching (5 at a time) for optimal performance

### **Modular Library Architecture**

- **`lib/http-meeting-scraper.js`**: Reusable HTTP scraping engine with session management
- **`lib/http-utils.js`**: Shared utilities for URL handling, date extraction, and HTML parsing
- **Clean Separation**: HTTP modules isolated from main scraper for maintainability
- **Dependency Injection**: Extraction functions passed as parameters to avoid circular dependencies

### **Enhanced User Experience**

- **Permalink Support**: File numbers are clickable links for easy URL copying
- **Clean Link Styling**: No underlines on permalinks to avoid confusing readers
- **Better Accessibility**: Proper anchor links with semantic HTML structure
- **Mobile Optimized**: Responsive design for all screen sizes

### **Two-Stage Processing Pipeline**

- **JSON Scraper** (`json-scraper.js`): Extracts and stores meeting data as structured JSON files
- **Markdown Converter** (`json-to-markdown.js`): Transforms JSON data into tm-static Markdown posts
- **Flexible Workflow**: Process meetings individually or by date with command-line options

### **Optimized Data Flow**

- **Single-Pass Content Cleaning**: Raw text stored in JSON, cleaned only during WordPress generation
- **Efficient Regex Processing**: Eliminated redundant boilerplate removal across multiple files
- **PDF Warning Suppression**: Cleaner console output with stderr redirection
- **Better Maintainability**: Single source of truth for content cleaning patterns

### **Enhanced Navigation & UX**

- **Session Headings**: Automatic "Morning Agenda" and "Evening Agenda" headings for multi-session days
- **Quick Navigation**: Jump links between morning and evening sessions
- **Anchor Links**: Direct linking to specific agenda sections with `#morning-agenda` and `#evening-agenda`
- **Smart Sorting**: Evening meetings always appear last, regardless of meeting types

### **Improved WordPress Integration**

- **Background Details**: Collapsible `<details>` blocks for agenda item backgrounds
- **Interactive Maps**: Automatic zoning maps for development applications with file number detection
- **Session Management**: Intelligent combining of same-date meetings into single WordPress files
- **Clean Markup**: Proper WordPress block structure with semantic HTML

### **Robust Data Storage**

- **Structured JSON**: Meeting data stored as searchable, reusable JSON files
- **Meeting Types**: Handles Regular, Evening, Special, and Workshop meetings
- **Date-based Organization**: Files organized by meeting dates for easy retrieval
- **Supporting Documents**: Complete document metadata with proper URL handling

## Quick Start

### Installation

```bash
npm install
```

### Environment Setup

Create a `.env` file in the project root with your Mapbox API token:

```bash
cp .env.example .env
```

Then edit `.env` and add your Mapbox API token:

```
MAPBOX_API_TOKEN=your_mapbox_api_token_here
```

**Note**: The Mapbox API token is required for geocoding TA/CPA parcel locations. Get your token from [Mapbox Account](https://account.mapbox.com/access-tokens/).

### Basic Usage

**Process all meetings and convert today's agendas:**

```bash
npm run process
```

**Process specific date:**

```bash
npm run process 2025-08-07
```

**Individual commands:**

```bash
# Scrape meetings to JSON
npm run scrape

# Convert JSON to WordPress markup
npm run convert -- --date 2025-08-07
```

## Command Line Options

### JSON Scraper (`json-scraper.js`)

```bash
node json-scraper.js [meetingId] [options]

Arguments:
  meetingId               Specific meeting ID to scrape (optional)

Options:
  --help, -h              Show help
  --date YYYY-MM-DD       Scrape all meetings for a specific date
  --type T                Meeting type for a by-id scrape (regular|evening|cra|workshop|special);
                          otherwise the current list, then the stored JSON, decide

Examples:
  node json-scraper.js                    # Scrape all available meetings (HTTP)
  node json-scraper.js 2608               # Scrape meeting 2608 (HTTP)
  node json-scraper.js --date 2025-10-09  # All meetings on Oct 9 (HTTP)
```

### Markdown Converter (`json-to-markdown.js`)

```bash
node json-to-markdown.js [options]

Options:
  -d, --date YYYY-MM-DD   Convert all meetings for a date (addenda auto-load)
      --dest <dir>        tm-static posts dir (default: $TM_STATIC_POSTS_DIR)
      --slug <slug>       Override the generated post slug
      --title <title>     Override the generated post title
  -f, --feature <item>    Feature an item in the preamble card (repeatable)
  -h, --help              Show help

Examples:
  node json-to-markdown.js 2634                    # Single meeting
  node json-to-markdown.js --date 2025-07-31       # All meetings on date
```

## NPM Scripts

| Script                       | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `npm run scrape`             | Run JSON scraper for all available meetings          |
| `npm run convert`            | Run Markdown converter (requires date/meeting args)  |
| `npm run process`            | Complete workflow: scrape + convert today's meetings |
| `npm run process 2025-08-07` | Complete workflow for specific date                  |
| `npm run vrb`                | Collect Variance Review Board agendas and minutes    |

## File Structure

### Core Scripts

- `json-scraper.js` - Extracts meeting data to JSON files (HTTP-only)
- `json-to-markdown.js` - Converts JSON to tm-static Markdown posts with permalink support
- `process-agenda.sh` - Automated workflow script

### Library Modules (v3.0+)

- `lib/http-meeting-scraper.js` - HTTP-based scraping engine for meeting data
- `lib/http-utils.js` - Shared parsers for the OnBase pages (date, name, time, agenda table, documents)
- `lib/retry.js` - One-retry wrapper used for item-detail and summary-sheet fetches
- `lib/scrape-guard.js` - Reconciles a fresh scrape with the stored file before it is written (see "Re-scrape safety")
- `lib/document-mirror.js` - R2 mirroring; `planDocumentFilenames` keeps same-titled documents on distinct keys
- `lib/change-log.js` / `lib/diff-meeting.js` - Public per-meeting change log; same-day entries merge

### Legacy Files (Deprecated)

⚠️ **The following files have been moved to `legacy/` and should not be used:**

- `legacy/agenda-scraper.js` - Original markdown-based scraper
- `legacy/wordpress-functions.js` - Legacy WordPress functions

**Use the current JSON-based workflow instead** (`json-scraper.js` + `json-to-markdown.js`)

### Data Organization

```
agenda-scraper/
├── data/                           # JSON meeting data
│   ├── meeting_2589_2025-07-31.json
│   └── meeting_2634_2025-07-31.json
├── agendas/                        # WordPress output files
│   ├── agenda_2025-07-31.wp.html   # Combined morning + evening
│   └── agenda_2025-08-07.wp.html   # Single meeting
└── output/                         # Legacy markdown files
```

### Supporting Files

- `format-helpers.js` - Text cleaning and formatting
- `agenda-styles.css` - Frontend WordPress styles
- `editor-agenda-styles.css` - WordPress editor styles

## Meeting JSON fields of note

- `meetingType` — 5-value enum (`regular|evening|cra|workshop|special`) derived
  from the OnBase type; drives ordering, slugs, and the site's type badge.
- `meetingName` — the clerk's own name for the meeting, read from the OnBase
  meeting page `<title>` (e.g. `"CRA Special Call"`, `"City Council FY27 Budget
  Workshop"`). The enum loses this ("CRA Special" → `special`), so the post
  title/session label and the DB `clerk_title` column use `meetingName` for
  `special` meetings. Absent on pre-2026-08 scrapes; backfill from the saved
  `output/http_meeting_<id>.html` pages with
  `node scripts/backfill-meeting-names.js` (safe — only adds the one field).
  An `evening` meeting with a non-generic name (the 9/8/26 "City Council
  Budget Public Hearing") also takes its post title and slug from it instead
  of the "Evening Land Use" default.
- `meetingTime` — start time as 24-hour `"HH:MM"`, read from the same page
  `<title>` (`"… - 9/10/2026 5:01:00 PM - …"`). The date alone cannot tell two
  same-day sessions of one type apart (two budget workshops on 2025-08-11).
  Absent on scrapes before 2026-09-08.
- `mirroredUrl` (per supporting document) — stamped by `mirror-documents.js`.
  Two documents in one item can share a title; the R2 key for the second
  and later gets `-2`, `-3` … before the extension, in page order (see
  `planDocumentFilenames` in `lib/document-mirror.js`).

## Re-scrape safety (`lib/scrape-guard.js`)

Before `json-scraper.js` writes a meeting file that already exists it
reconciles the fresh scrape with the stored one:

- **Refused** (error, file untouched): the scrape has 0 items while the
  stored file has some, or every item fetch failed.
- **Kept per item**: an item whose detail fetch failed (after one retry) or
  that lost every document keeps its stored version; the log says so.
- **Carried forward**: `mirroredUrl` by document identity (title + ordinal
  for repeats), so re-scrapes never drop R2 links; and `coordinates`,
  `location` and `folioNumbers` when the fresh scrape has them empty, so the
  nightly (which has no `MAPBOX_API_TOKEN`) cannot blank a geocode a local
  run made. A fresh non-empty value always wins.

`node json-scraper.js <id>` for a meeting no longer on the OnBase list keeps
the stored `meetingType`/`meetingName` (it used to demote to `regular`).
Same-day change-log entries merge rather than overwrite, so a manual run
after the nightly cannot erase the nightly's entries.

## Map locations (`locate-records.js`)

The agenda post's map used to find every land use record in the live dev-coord
feed when a reader opened the post, so a pin vanished once the City archived
the record. `process-agenda.sh` now runs `locate-records.js` (step 3b, between
the OpenGov reconcile and the Markdown step). It looks up each mappable record
the scraper did not geocode itself, in the feed's `current` view and then
`archived`, and stores the answer in a sidecar:

```
data/locations/<meetingId>-<date>-locations.json
```

`json-to-markdown.js` emits stored locations as explicit coordinates in the
map block's `data-folios`, with the popup's address and Accela link in
`data-record-details`. Notes:

- **A sidecar, not a field on the item**, because the nightly scrape rewrites
  the meeting files (the funding manifest works the same way).
- **Add-only.** A located record stays located whatever later happens in the
  feed; nothing is ever replaced or removed.
- **Never fatal.** If the feed is down, or a record is not in it, the record
  stays in `data-records` and the map looks it up live, exactly as before.
- **Points outside the city are rejected** (`inCityBounds` in
  `lib/dev-coord.js`): the feed carries the City's own geocodes and some are
  wrong, e.g. AB2-26-0000017 downtown plotted near Plant City.
- Forward-only: older posts are not regenerated. Re-running
  `process-agenda.sh <date>` for an old meeting will locate what it still can.

## Variance Review Board collector (`vrb-scraper.js`)

The VRB posts its agendas and minutes on tampa.gov, not OnBase: a listing page
links to a document page, which links to a PDF. `vrb-scraper.js` follows both
hops, extracts the PDF text with `lib/pdf-text-extractor.js`, and parses the
agenda's case blocks. It is collect-only. Nothing downstream (`build-db`, the
site, the agenda posts) reads its output yet, and it is independent of
`process-agenda.sh`.

```bash
node vrb-scraper.js             # collect new and recently changed documents
node vrb-scraper.js --all       # re-check every listed document page
node vrb-scraper.js --mirror    # also copy PDFs to R2 (needs the S3_* env)
node vrb-scraper.js --geo       # also look up unlocated cases in old hearings
node vrb-scraper.js --reparse   # re-run the parser over stored text, offline
```

The nightly workflow runs it with no flags. A normal run is two listing
requests plus the document pages of any hearing less than 14 days old; older
hearings are treated as settled unless `--all` is passed. Requests are spaced a
second apart.

```
data/vrb/
├── vrb_2026-09-15.json             # one file per hearing
└── text/
    └── vrb-agenda-sept-2026-194736.txt   # pdf-parse output, one per document
```

Each hearing file holds:

- `documents` — every agenda and minutes document posted for that hearing, with
  `pdfUrl`, `pdfSha256`, `postedDate`, `updatedTime`, `firstSeen`, and
  `mirroredUrl` once mirrored. When staff replace the PDF on an existing
  document page the old entry moves to that document's `previousVersions`.
- `canonicalAgenda` — the latest posted agenda. The VRB posts "updated" agendas
  as separate documents; earlier ones stay in `documents` as history.
- `cases` — parsed from the canonical agenda: `itemNumber`, `caseNumber`
  (`VRB-26-28`), `note` ("Continued from…", "Mis-notice"), `section`,
  `owner`/`applicant`, `location`, `folio`, `zoning`, `request`, `codeSection`,
  and `neighborhoodAssociations`, the City's list of associations notified for
  the case (`neighborhoodAssociationsRaw` keeps it as typed).
- `cases[].geo` — `lat`, `lng`, the City's `neighborhood` label,
  `councilDistrict`, `accelaUrl` and the feed's `address`, looked up in the
  dev-coord Datasette by Accela record id (`VRB-26-28` → `VRB-26-0000028`) when
  the case is collected, because the feed archives closed records. A record is
  attached only if its house number matches the agenda's; a disagreement goes
  to `geoWarnings` and the case stays unlocated. `null` until found; recent
  hearings are retried nightly.
- **Withheld locations stay withheld, and the rule errs toward privacy.** When
  the agenda gives no street address (VRB-26-69 lists owner and location as
  "Confidential", the City's mark for a public-records exemption), the case is
  flagged `locationWithheld: true` and everything that could identify the
  parcel is dropped from what this repo publishes: `folio` is `null` even
  though the City's PDF prints it, the folio is blanked to `[withheld]` in the
  stored `text/` files (agenda and minutes), and `geo` is never looked up even
  though the feed has the address. Enforced in `lib/vrb-parser.js`
  (`hasStreetAddress`, `redactWithheldText`) and `lib/dev-coord.js`
  (`isLocatable`), at collection and again on every re-derive. Anything built
  on this data (pages, maps, alerts, new enrichment) must respect
  `locationWithheld`. The mirrored PDF is the City's document, unaltered.
- `warnings` — anything the parser did not expect. Fields are stored as the
  clerk typed them, stray commas and folio variants included.

Minutes are collected as text only. They repeat each case block followed by a
`BOARD VOTE:` line, so outcomes are parseable later from `text/`.

The PDF bytes are kept only by `--mirror` (R2 key
`boards/vrb/<hearing date>/<sha8>-<filename>`), which the nightly does not run:
it has no R2 credentials, same as council documents. Run it by hand after a new
agenda shows up in the nightly issue. The extracted text is in git either way.

Parser rules live in `lib/vrb-parser.js` and are pinned by `test/vrb.test.js`
against real agendas in `test/fixtures/vrb/`. `lib/tampa-gov-documents.js`
(listing and document-page parsing) is board-agnostic and is the starting point
for the ARC and BLC agendas, which use a different PDF template.

## Output Examples

### Single Meeting Output

```html
<!-- Quick intro paragraph -->
<!-- Single "Agenda" heading with anchor -->
<!-- Meeting link and agenda items -->
```

### Multiple Meetings Output

```html
<!-- Quick intro paragraph -->
<!-- Navigation: Morning Agenda | Evening Agenda -->
<!-- Morning Agenda heading and items -->
<!-- Evening Agenda heading and items -->
```

### Enhanced Features

- **Background Details**: `<details>` blocks with "Background" summary
- **Supporting Documents**: Properly formatted document links
- **Interactive Maps**: Automatic map blocks for zoning applications
- **Smart Formatting**: File numbers in `<strong>` tags for development items

## Dependencies

- **cheerio**: HTML parsing and content extraction
- **axios**: HTTP requests and web data fetching
- **pdf-parse**: PDF text extraction capabilities

## Version History

### v3.0.0 (Current)

**Major Architecture Update**

- **HTTP-First Scraper**: Complete migration from Selenium to HTTP-based scraping with 3-5x performance improvement (2 minutes vs 5-10 minutes for 76 items)
- **Modular Library Architecture**: New `lib/` directory with reusable `http-meeting-scraper.js` and `http-utils.js` modules
- **Parallel Processing**: 5 concurrent item fetches for optimal performance
- **Permalink Support**: File No. text now functions as clickable permalink for easy agenda item link copying
- **Enhanced User Experience**: Right-click File No. → "Copy Link Address" workflow for agenda item sharing

### v2.2.0

- **🔍 Enhanced Agenda Item Detection**: Fixed missing unlinked agenda items using advanced table-based parsing
- **⚡ Performance Optimization**: Direct ID-based item loading eliminates sequential clicking for 30-50% speed improvement
- **🎯 Improved Data Accuracy**: Better item sequencing and reduced race conditions in content extraction
- **🔧 Robust ID Matching**: Multi-strategy file number matching ensures complete agenda item coverage
- **📊 Better Error Handling**: Simplified validation logic with improved reliability

### v2.0.0

- **🔄 Architecture Redesign**: Split into two-stage pipeline (JSON storage + WordPress conversion)
- **📱 Enhanced Navigation**: Added session headings and quick navigation links
- **🎯 Smart Meeting Sorting**: Evening meetings always appear last
- **⚓ Anchor Links**: Direct linking to morning/evening agenda sections
- **📁 Structured Data**: JSON-first approach with reusable meeting data
- **🛠 Flexible Workflow**: Command-line options for dates and meeting IDs
- **📋 NPM Scripts**: Streamlined processing with `npm run process`
- **🔧 Robust Error Handling**: Better validation and failure recovery
- **📊 Multiple Meeting Types**: Support for Regular, Evening, Special, Workshop meetings

### v1.2.0

- **Fixed Duplicate Content Issue**: Resolved agenda items with identical file numbers showing duplicate content
- **Enhanced Content Validation**: Improved wait conditions for reliable content loading
- **Retry Logic**: Added automatic retry mechanism for incorrect content detection

### v1.1.1

- **Production Code Cleanup**: Removed debugging code for cleaner output
- **File Organization**: Deleted obsolete utility files
- **Maintainability Improvements**: Streamlined codebase

### v1.1.0

- **Fixed PDF Background Formatting**: Structure-based text formatting preserving lists and paragraphs
- **Enhanced Meeting Date Extraction**: Improved date parsing with error handling
- **Dollar Amount Preservation**: Fixed monetary value corruption during processing

### v1.0.0

- Complete rewrite with supporting documents and background extraction
- WordPress block markup output and CSS theme integration
- Interactive zoning map integration and automated PDF text extraction

## License

MIT License

## Author

Michael Bishop (https://michaelbishop.me/)

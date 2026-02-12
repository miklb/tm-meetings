# Tampa Agenda Scraper - Copilot Instructions

## Architecture Overview

Three-stage pipeline for Tampa City Council agenda processing:

```
json-scraper.js → mirror-documents.js → json-to-wordpress.js
     ↓                   ↓                     ↓
 data/*.json        (adds mirroredUrl)    agendas/*.wp.html
```

**Why this matters**: OnBase `publishId` in URLs changes when agendas update, breaking links. We mirror documents to stable S3 storage using `itemId` (stable) in the path.

## Key Workflows

```bash
# Full workflow (scrape + convert today)
npm run process

# Specific date workflow
node json-scraper.js --date 2025-12-11
node mirror-documents.js --date 2025-12-11
node json-to-wordpress.js --date 2025-12-11

# Single meeting
node json-scraper.js 2650
```

## File Naming Patterns

| Type         | Pattern                                   | Example                                     |
| ------------ | ----------------------------------------- | ------------------------------------------- |
| Meeting JSON | `data/meeting_{id}_{date}.json`           | `meeting_2650_2025-12-11.json`              |
| WordPress    | `agendas/agenda_{date}.wp.html`           | `agenda_2025-12-11.wp.html`                 |
| S3 Key       | `{date}/meeting-{id}/{itemId}/{file}.pdf` | `2025-12-11/meeting-2650/19537/summary.pdf` |

## Code Patterns

### Module Organization

- **`lib/http-meeting-scraper.js`**: HTTP session management, meeting/item fetching
- **`lib/http-utils.js`**: URL handling, date extraction, HTML parsing (exports `BASE_URL`, `absoluteUrl`, `extractMeetingDate`)
- **`lib/document-mirror.js`**: `DocumentMirror` class for S3 uploads
- **`format-helpers.js`**: `toTitleCase()` with acronym preservation (TPD, FSA, HPC, etc.)
- **`staff-report-parser.js`**: PDF parsing, folio extraction for land use cases

### Dependency Injection Pattern

Extraction functions passed as parameters to avoid circular dependencies:

```javascript
// lib/http-meeting-scraper.js uses injected extractors
const { fetchMeeting } = require("./lib/http-meeting-scraper");
```

### Error Handling

Always wrap async operations and log progress:

```javascript
try {
  console.log(`⏳ Processing meeting ${meetingId}...`);
  // ... operation
  console.log(`✓ Completed ${meetingId}`);
} catch (error) {
  console.error(`❌ Failed ${meetingId}:`, error.message);
}
```

## Data Structures

### Agenda Item (in meeting JSON)

```javascript
{
  "agendaItemId": "19537",      // Stable ID for file paths
  "fileNumber": "REZ-25-001",   // Land use case identifier
  "title": "File No. REZ-25-001 - Rezoning Request",
  "background": "...",          // From PDF staff report
  "supportingDocuments": [{
    "url": "https://tampagov.hylandcloud.com/...",
    "mirroredUrl": "https://pub-XXX.r2.dev/...",
    "title": "Staff Report Final"
  }]
}
```

### File Number Patterns (land use)

- `REZ-*` - Rezoning
- `VAC-*` - Vacation
- `SU-*` - Special Use
- `TA/CPA-*` or `CPA-*` - Text Amendment / Comprehensive Plan

## Testing

Run individual test files directly:

```bash
node test-json-scraper.js      # Validate scraper
node test-agenda-parsing.js    # Parser logic
node test-folio-parser.js      # PDF folio extraction
```

## Environment Variables

Required for document mirroring:

```bash
S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx
S3_BUCKET=agenda-docs
S3_PUBLIC_URL=https://pub-XXX.r2.dev
S3_CUSTOM_DOMAIN=true  # If using custom domain
MAPBOX_API_TOKEN=xxx   # For geocoding
```

## Important Conventions

- **Dates**: Always `YYYY-MM-DD` format
- **JSON**: 2-space indentation
- **Async**: Use `async/await`, not Promise chains
- **Selenium**: Only fallback via `--selenium` flag; HTTP is default and 3-5x faster
- **Legacy code**: In `legacy/` - don't use, kept for reference only

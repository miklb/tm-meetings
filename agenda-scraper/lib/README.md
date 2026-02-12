# HTTP Scraper Library

Reusable HTTP-based agenda scraping modules without Selenium dependency.

## Modules

### `http-meeting-scraper.js`

Core HTTP scraping functionality for fetching Tampa City Council meeting data.

#### Functions

**`createSession()`**
Creates an axios client with cookie jar support.

```javascript
const session = await createSession();
```

**`fetchMeetingList(options)`**
Fetches list of upcoming meetings from main agenda page.

```javascript
const meetings = await fetchMeetingList({ session });
// Returns: [{ id, type, href }, ...]
// Types: 'regular', 'evening', 'workshop', 'special', 'cra'
```

**`fetchMeeting(meetingId, meetingType, options)`**
Fetches complete meeting data including all agenda items.

```javascript
const meetingData = await fetchMeeting("2666", "regular", {
  session,
  saveDebugFiles: true,
  extractFileNumber, // Required: from json-scraper.js
  extractDollarAmounts, // Required: from json-scraper.js
  formatBackgroundText, // Required: from json-scraper.js
  parseSummaryFinancialEntries, // Required: from json-scraper.js
});
```

Returns:

```javascript
{
  meetingId: '2666',
  meetingType: 'regular',
  meetingDate: 'September 18, 2025',
  agendaItems: [
    {
      number: 1,
      agendaItemId: '17223',
      title: '...',
      fileNumber: 'CM25-17223',
      background: '...',
      supportingDocuments: [...],
      folioNumbers: ['123456.0000', '789012.0000'], // For TA/CPA items only
      dollarAmounts: [...],
      financialDetails: [...],
      financialTotals: { ... }
    },
    // ...
  ],
  financialSummary: {
    expenditures: 12345.67,
    decreases: 0,
    revenues: 0,
    other: 0,
    net: 12345.67,
    formatted: {
      expenditures: '$12,345.67',
      // ...
    }
  }
}
```

### `http-utils.js`

Shared utility functions for HTTP scraping.

#### Functions

- **`absoluteUrl(relativeOrAbsolute)`** - Convert URLs to absolute
- **`convertToDirectPDFUrl(downloadFileUrl)`** - Convert to direct PDF URLs
- **`extractMeetingDate(html)`** - Extract meeting date from HTML
- **`parseLoadAgendaFromSource(source)`** - Parse loadAgendaItem config
- **`extractLoadAgendaConfig(client, html)`** - Extract AJAX config from page
- **`parseAgendaTable(html, extractFileNumber)`** - Parse agenda table
- **`parseSupportingDocuments(html)`** - Extract document links
- **`formatCurrency(value)`** - Format numeric values as currency

### `pdf-folio-parser.js`

PDF parsing module for extracting folio numbers from TA/CPA TCC PACKET documents.

#### Functions

**`extractFolioNumbers(pdfUrl, fileNumber)`**
Downloads and parses a TA/CPA TCC PACKET PDF to extract folio numbers.

```javascript
const folios = await extractFolioNumbers(
  "https://tampagov.hylandcloud.com/.../TA%20CPA%2025-09%20TCC%20PACKET.PDF",
  "TA/CPA25-09"
);
// Returns: ['189020.0000', '189021.0000', ...]
```

**`extractFolioNumbersFromFile(filePath)`**
Parse a local PDF file (for testing).

```javascript
const folios = await extractFolioNumbersFromFile(
  "./TA_CPA_25-09_TCC_PACKET.PDF"
);
```

**`findTccPacketUrl(supportingDocuments)`**
Find the TCC PACKET PDF URL in an item's supporting documents array.

```javascript
const tccUrl = findTccPacketUrl(item.supportingDocuments);
if (tccUrl) {
  const folios = await extractFolioNumbers(tccUrl, item.fileNumber);
}
```

#### How It Works

1. Downloads PDF from provided URL
2. Parses PDF text content using `pdf-parse`
3. Searches for "Plan Amendment Request" section
4. Locates "Folio Numbers:" subsection
5. Extracts all numeric folio patterns (e.g., `123456.0000`)
6. Filters and deduplicates results
7. Returns sorted array of folio numbers

**Note**: Only TA/CPA items with TCC PACKET PDFs will have folio numbers extracted. Other items will have an empty `folioNumbers` array.

## Usage Example

```javascript
const {
  createSession,
  fetchMeetingList,
  fetchMeeting,
} = require("./lib/http-meeting-scraper");
const {
  extractFileNumber,
  extractDollarAmounts,
  formatBackgroundText,
  parseSummaryFinancialEntries,
} = require("./json-scraper");

async function scrapeAgenda() {
  // Create reusable session
  const session = await createSession();

  // Get list of meetings
  const meetings = await fetchMeetingList({ session });

  // Fetch first meeting
  const meetingData = await fetchMeeting(meetings[0].id, meetings[0].type, {
    session,
    extractFileNumber,
    extractDollarAmounts,
    formatBackgroundText,
    parseSummaryFinancialEntries,
  });

  console.log(`Found ${meetingData.agendaItems.length} items`);
}
```

## Testing

Run the test script:

```bash
# Test with specific meeting ID
node test-http-module.js 2666

# Test meeting list only
node test-http-module.js --list
```

## Architecture

The HTTP scraper follows this flow:

1. **Session Creation**: Establishes axios client with cookie jar
2. **Meeting Discovery** (optional): Fetches list of upcoming meetings
3. **Meeting Page Fetch**: Downloads main meeting page HTML
4. **Config Extraction**: Parses `loadAgendaItem` JavaScript function
5. **Agenda Document Fetch**: Downloads agenda table HTML
6. **Item Parsing**: Extracts item numbers and IDs from table
7. **Detail Fetch**: For each item, fetches detail page via AJAX
8. **Document Parsing**: Extracts supporting documents
9. **Summary Sheet Processing**: Downloads and parses PDF summary sheets
10. **Financial Extraction**: Parses dollar amounts and fiscal data
11. **Data Assembly**: Combines all data into structured object

## Debug Files

When `saveDebugFiles: true`, the scraper writes:

- `output/http_meeting_<id>.html` - Main meeting page
- `output/http_agenda_<id>.html` - Agenda table document
- `output/http_test_<id>.json` - Complete meeting data (if using test script)

## Dependencies

- `axios` + `axios-cookiejar-support` - HTTP requests with cookies
- `tough-cookie` - Cookie jar implementation
- `cheerio` - HTML parsing
- `pdf-parse` - PDF text extraction

## Migration Status

See `docs/http-migration-checklist.md` for current progress toward full HTTP migration.

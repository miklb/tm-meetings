# Fix: Preserve Mirrored Document URLs Across Re-scrapes

## Problem

Three related issues cause mirrored document URLs to be fragile:

1. **`json-scraper.js` overwrites JSON files from scratch** — it never reads existing data, so `mirroredUrl` values added by `mirror-documents.js` are lost on every re-scrape.

2. **Mirroring is a separate manual step** — `process-agenda.sh` runs `json-scraper.js` then `json-to-wordpress.js` but never calls `mirror-documents.js`. If you forget to mirror before the next scrape, the window closes.

3. **OnBase URLs are ephemeral** — the city's `publishId` parameter changes when agendas are updated. A URL scraped on Friday may 404 by Monday. Once a document is mirrored to R2, we should never need the OnBase URL again — but right now a re-scrape throws away the R2 link and replaces it with a fresh (possibly already-stale) OnBase URL.

### Current flow (broken)

```
Friday:   scrape → JSON has valid OnBase URLs
Friday:   mirror → R2 copies made, mirroredUrl added to JSON ✓
Monday:   city updates agenda, publishIds change
Tuesday:  nightly scrape → JSON overwritten → mirroredUrl GONE
                                             → OnBase URLs now stale
```

## Proposed Solution

Two changes, both in `json-scraper.js`. No changes to `mirror-documents.js` or `document-mirror.js`.

### Change 1: Preserve `mirroredUrl` on re-scrape

Before writing the JSON output, load the existing file (if any) and build a lookup of known mirrored URLs. When assembling the new `supportingDocuments` array, carry forward `mirroredUrl` from any matching document.

**Match key:** `agendaItemId` + sanitized document title (lowercased, spaces→hyphens). This is the same key derivation used for S3 paths, so it's guaranteed stable.

```javascript
// In json-scraper.js, before writeFileSync

// Load existing file to preserve mirroredUrl values
const existingMirrorMap = new Map();
if (fs.existsSync(outputFileName)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outputFileName, "utf8"));
    for (const item of existing.agendaItems || []) {
      for (const doc of item.supportingDocuments || []) {
        if (doc.mirroredUrl && item.agendaItemId) {
          const key = `${item.agendaItemId}:${sanitizeForKey(doc.title || doc.originalText)}`;
          existingMirrorMap.set(key, doc.mirroredUrl);
        }
      }
    }
  } catch (e) {
    // Existing file is malformed — proceed without merge
  }
}

// Restore mirroredUrl on matching documents
for (const item of meetingData.agendaItems) {
  for (const doc of item.supportingDocuments || []) {
    const key = `${item.agendaItemId}:${sanitizeForKey(doc.title || doc.originalText)}`;
    const existing = existingMirrorMap.get(key);
    if (existing) {
      doc.mirroredUrl = existing;
    }
  }
}

fs.writeFileSync(outputFileName, JSON.stringify(meetingData, null, 2));
```

The `sanitizeForKey` function can reuse the same logic as `document-mirror.js`'s `sanitizeFilename`, or a simpler version:

```javascript
function sanitizeForKey(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "");
}
```

### Change 2: Integrate mirroring into `process-agenda.sh`

Add a mirroring step after scraping, with a `--skip-mirror` flag for when you're offline or just want to scrape:

```bash
# In process-agenda.sh, after json-to-wordpress step:

if [ "$SKIP_MIRROR" != "true" ]; then
    echo "Step 3: Mirroring documents to R2..."
    node mirror-documents.js --date "$DATE"
fi
```

This ensures every scrape automatically mirrors new documents before the OnBase URLs go stale.

## What this fixes

### After the changes

```
Friday:   scrape → JSON written (fresh OnBase URLs)
Friday:   mirror runs automatically → new docs uploaded to R2, mirroredUrl set
Monday:   city updates agenda, publishIds change
Tuesday:  nightly scrape → JSON overwritten BUT mirroredUrl preserved from old file
          ↳ new documents get fresh OnBase URLs (ready to mirror)
          ↳ existing documents keep their R2 links
Tuesday:  mirror runs automatically → only NEW docs uploaded (existing ones skip via HeadObject)
```

### What about the `exists()` check in mirror?

The existing `exists()` check (HeadObject against the S3 key) already handles deduplication correctly:

- Same document title for same item → same S3 key → `exists()` returns true → skip upload
- Truly new document → new S3 key → `exists()` returns false → download and upload

No changes needed in `mirror-documents.js` or `document-mirror.js`.

### What about OnBase URL freshness?

Even when `mirroredUrl` is preserved, the `url` field (OnBase source) will reflect the latest publishId from the most recent scrape. This is fine — the source URL is kept for provenance, and `mirroredUrl` is used for actual linking. If you ever needed to re-download a document (e.g., the city corrected it), you could use `--force` with the current OnBase URL.

## Edge cases

| Scenario                                                                  | Behavior                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| City adds a new document to existing item                                 | New doc has no `mirroredUrl`, gets mirrored on next run                                  |
| City removes a document from an item                                      | Old `mirroredUrl` not carried forward (doc not in new scrape), R2 copy remains as orphan |
| City renames a document                                                   | Treated as remove + add — new upload under new key, old copy orphaned                    |
| Document title collision (two docs with same sanitized name in same item) | Last one wins in the map — unlikely in practice since item-level titles are distinct     |
| Existing JSON file is corrupt/unreadable                                  | try/catch falls through, proceeds without merge (same as fresh scrape)                   |

## Current Mirroring Status (March 19, 2026)

**5,675 / 5,677** documents mirrored across 61 meetings. 2 upload failures (1 each in meetings 2608 and 2708).

### Meetings with zero supporting documents (14)

| File                             | Meeting ID | Date       | Type                |
| -------------------------------- | ---------- | ---------- | ------------------- |
| meeting_2719_2025-10-09.json     | 2719       | 2025-10-09 | regular             |
| meeting_2725_2025-11-10.json     | 2725       | 2025-11-10 | special             |
| meeting_2745_2025-12-17.json     | 2745       | 2025-12-17 | special             |
| meeting_2781_2025-12-18.json     | 2781       | 2025-12-18 | regular             |
| meeting_2787_2026-01-08.json     | 2787       | 2026-01-08 | regular             |
| meeting_2790_2026-01-13.json     | 2790       | 2026-01-13 | special             |
| meeting_2791_2025-01-14.json     | 2791       | 2025-01-14 | special             |
| meeting_2801_2025-01-14.json     | 2801       | 2025-01-14 | special             |
| meeting_2802_2025-01-21.json     | 2802       | 2025-01-21 | special             |
| meeting_2806_2026-02-18.json     | 2806       | 2026-02-18 | special             |
| meeting_2806_2026-02-18_old.json | 2806       | 2026-02-18 | special (duplicate) |
| meeting_2823_2026-02-05.json     | 2823       | 2026-02-05 | regular             |
| meeting_2830_2026-02-19.json     | 2830       | 2026-02-19 | regular             |
| meeting_2837_2026-03-03.json     | 2837       | 2026-03-03 | special             |

Most are special meetings (procedural, no attachments). Regular meetings (2719, 2781, 2787, 2823, 2830) may be evening/workshop sessions or draft agendas scraped before documents were posted. `meeting_2806_2026-02-18_old.json` is a leftover duplicate to clean up.

## Not in scope

- **Orphan cleanup in R2** — removed/renamed documents leave old copies. A separate cleanup script could compare R2 keys against current JSON data. Low priority since R2 storage is cheap.
- **Document change detection** — if the city replaces a PDF with an updated version under the same title, we won't re-upload it. The `--force` flag handles this manually. SHA256 hashing (planned in IMPLEMENTATION_PLAN.md as `document_versions` table) would automate it later.
- **Nightly GH Action integration** — the action currently only runs `json-scraper.js` and `json-to-wordpress.js`. Adding mirroring to the action requires R2 credentials as GitHub secrets. Separate task.

// Tests for the agenda scraper's pure logic — run with `npm test` (node --test).
// Nothing here touches OnBase, R2, or the data/ directory.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withRetry } = require('../lib/retry');
const { extractMeetingTime, extractMeetingName } = require('../lib/http-utils');
const { DocumentMirror, planDocumentFilenames } = require('../lib/document-mirror');
const { documentKeys, mergeWithExisting } = require('../lib/scrape-guard');
const { appendOrMergeEntry } = require('../lib/change-log');
const { typeInfo } = require('../json-to-markdown');

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

test('withRetry retries once after a failure and returns the second result', async () => {
  let calls = 0;
  const logs = [];
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('socket hang up');
    return 'ok';
  }, { delayMs: 1, label: 'item 4 detail', log: (m) => logs.push(m) });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.match(logs[0], /item 4 detail failed \(attempt 1\/2\): socket hang up/);
});

test('withRetry gives up after the last attempt with the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, { attempts: 3, delayMs: 1, log: () => {} }),
    /fail 3/
  );
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------------------
// Meeting time from the OnBase page title
// ---------------------------------------------------------------------------

test('extractMeetingTime reads the 24h start time from the page title', () => {
  const html = '<html><head><title>City Council Evening - September 10, 2026 - 9/10/2026 5:01:00 PM - OnBase Agenda Online</title></head></html>';
  assert.equal(extractMeetingTime(html), '17:01');
  assert.equal(extractMeetingName(html), 'City Council Evening');
});

test('extractMeetingTime handles morning, noon, midnight and missing times', () => {
  const t = (s) => extractMeetingTime(`<title>X - 8/11/2025 ${s} - OnBase</title>`);
  assert.equal(t('9:00:00 AM'), '09:00');
  assert.equal(t('12:00:00 PM'), '12:00');
  assert.equal(t('12:30:00 AM'), '00:30');
  assert.equal(t('5:01 PM'), '17:01');
  assert.equal(extractMeetingTime('<title>View Meeting</title>'), '');
  assert.equal(extractMeetingTime(''), '');
});

// ---------------------------------------------------------------------------
// R2 filenames: repeated titles within one item
// ---------------------------------------------------------------------------

function mirror() {
  return new DocumentMirror({ endpoint: 'https://s3.test', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b', publicUrlBase: 'https://docs.test' });
}

test('planDocumentFilenames gives repeated titles in one item distinct names in page order', () => {
  const m = mirror();
  const docs = [
    { title: 'REZ-25-104 CERTIFIED APP_REVISED.PDF', url: 'https://x/DownloadFileBytes/a.PDF.pdf?publishId=168367' },
    { title: 'STAFF REPORT.PDF', url: 'https://x/DownloadFileBytes/b.PDF.pdf?publishId=1' },
    { title: 'REZ-25-104 CERTIFIED APP_REVISED.PDF', url: 'https://x/DownloadFileBytes/a.PDF.pdf?publishId=168368' },
    { title: 'REZ-25-104 CERTIFIED APP_REVISED.PDF', url: 'https://x/DownloadFileBytes/a.PDF.pdf?publishId=168369' },
  ];
  const names = planDocumentFilenames(docs, (n) => m.sanitizeFilename(n), (u) => m.getExtFromUrl(u));
  assert.deepEqual(names, [
    'REZ-25-104 CERTIFIED APP_REVISED.PDF',
    'STAFF REPORT.PDF',
    'REZ-25-104 CERTIFIED APP_REVISED-2.PDF',
    'REZ-25-104 CERTIFIED APP_REVISED-3.PDF',
  ]);
  const keys = names.map((n) => m.generateKey('2026-01-08', '2564', '40', n));
  assert.equal(new Set(keys).size, 4, 'four distinct R2 keys');
  assert.equal(keys[0], '2026-01-08/meeting-2564/40/rez-25-104-certified-app_revised.pdf', 'first keeps the legacy key');
});

test('planDocumentFilenames treats titles that sanitize to the same key as repeats', () => {
  const m = mirror();
  const names = planDocumentFilenames(
    [{ title: 'Exhibit A' }, { title: 'EXHIBIT  A' }, { title: 'exhibit-a.pdf' }],
    (n) => m.sanitizeFilename(n), () => null
  );
  assert.deepEqual(names, ['Exhibit A', 'EXHIBIT  A-2', 'exhibit-a-3.pdf']);
});

test('planDocumentFilenames takes the extension from the download URL', () => {
  const m = mirror();
  const names = planDocumentFilenames(
    [{ title: 'Memo.DOCX', url: 'https://x/DownloadFileBytes/Memo.DO.pdf?publishId=5' }],
    (n) => m.sanitizeFilename(n), (u) => m.getExtFromUrl(u)
  );
  assert.deepEqual(names, ['Memo.pdf']);
});

// ---------------------------------------------------------------------------
// Scrape guard
// ---------------------------------------------------------------------------

const doc = (title, mirroredUrl) => ({ title, url: `https://onbase/${title}`, ...(mirroredUrl ? { mirroredUrl } : {}) });
const item = (id, extra = {}) => ({ number: id, agendaItemId: String(id), title: `Item ${id}`, background: 'bg', supportingDocuments: [], ...extra });
const meeting = (items) => ({ meetingId: '1', agendaType: 'FINAL', agendaItems: items });

test('documentKeys distinguishes repeated titles by ordinal', () => {
  assert.deepEqual(documentKeys([doc('A.pdf'), doc('B.pdf'), doc('a.pdf'), doc('A.PDF')]), ['a.pdf', 'b.pdf', 'a.pdf#2', 'a.pdf#3']);
});

test('a first scrape is written as-is', () => {
  const fresh = meeting([item(1)]);
  const r = mergeWithExisting(null, fresh);
  assert.equal(r.refused, null);
  assert.equal(r.data, fresh);
});

test('a scrape with zero items is refused when the stored file has items', () => {
  const r = mergeWithExisting(meeting([item(1), item(2)]), meeting([]));
  assert.match(r.refused, /0 items but the stored file has 2/);
});

test('a scrape where every item fetch failed is refused', () => {
  const r = mergeWithExisting(meeting([item(1)]), meeting([item(1, { error: 'timeout' }), item(2, { error: 'timeout' })]));
  assert.match(r.refused, /every one of 2 item fetches failed/);
});

test('an item whose fetch failed keeps its stored version; the rest update', () => {
  const stored = meeting([
    item(1, { supportingDocuments: [doc('Summary.pdf', 'https://r2/1/summary.pdf')], background: 'old bg 1' }),
    item(2, { background: 'old bg 2' }),
  ]);
  const fresh = meeting([
    item(1, { error: 'socket hang up', supportingDocuments: [], background: '' }),
    item(2, { background: 'new bg 2' }),
  ]);
  const r = mergeWithExisting(stored, fresh);
  assert.equal(r.refused, null);
  assert.deepEqual(r.keptItems, [{ number: 1, agendaItemId: '1', reason: 'fetch failed: socket hang up' }]);
  assert.equal(r.data.agendaItems[0].background, 'old bg 1');
  assert.equal(r.data.agendaItems[0].supportingDocuments[0].mirroredUrl, 'https://r2/1/summary.pdf');
  assert.equal(r.data.agendaItems[1].background, 'new bg 2');
});

test('an item that lost all its documents keeps its stored version', () => {
  const stored = meeting([item(1, { supportingDocuments: [doc('A.pdf', 'https://r2/a'), doc('B.pdf', 'https://r2/b')] })]);
  const fresh = meeting([item(1, { supportingDocuments: [] })]);
  const r = mergeWithExisting(stored, fresh);
  assert.equal(r.keptItems[0].reason, 'all 2 documents missing');
  assert.equal(r.data.agendaItems[0].supportingDocuments.length, 2);
});

test('a genuinely removed document is not treated as a failure', () => {
  const stored = meeting([item(1, { supportingDocuments: [doc('A.pdf', 'https://r2/a'), doc('B.pdf', 'https://r2/b')] })]);
  const fresh = meeting([item(1, { supportingDocuments: [doc('A.pdf')] })]);
  const r = mergeWithExisting(stored, fresh);
  assert.deepEqual(r.keptItems, []);
  assert.equal(r.data.agendaItems[0].supportingDocuments.length, 1);
  assert.equal(r.data.agendaItems[0].supportingDocuments[0].mirroredUrl, 'https://r2/a');
  assert.equal(r.restoredMirrors, 1);
});

test('mirroredUrl carries forward per document, including same-titled documents', () => {
  const stored = meeting([item(7, { supportingDocuments: [doc('Report.pdf', 'https://r2/report.pdf'), doc('Report.pdf', 'https://r2/report-2.pdf')] })]);
  const fresh = meeting([item(7, { supportingDocuments: [doc('Report.pdf'), doc('Report.pdf'), doc('New.pdf')] })]);
  const r = mergeWithExisting(stored, fresh);
  const urls = r.data.agendaItems[0].supportingDocuments.map((d) => d.mirroredUrl || null);
  assert.deepEqual(urls, ['https://r2/report.pdf', 'https://r2/report-2.pdf', null]);
  assert.equal(r.restoredMirrors, 2);
});

test('a fresh mirroredUrl is not overwritten by the stored one', () => {
  const stored = meeting([item(1, { supportingDocuments: [doc('A.pdf', 'https://r2/old')] })]);
  const fresh = meeting([item(1, { supportingDocuments: [doc('A.pdf', 'https://r2/new')] })]);
  const r = mergeWithExisting(stored, fresh);
  assert.equal(r.data.agendaItems[0].supportingDocuments[0].mirroredUrl, 'https://r2/new');
  assert.equal(r.restoredMirrors, 0);
});

test('items without an agendaItemId are passed through unchanged', () => {
  const stored = meeting([{ number: 1, agendaItemId: null, title: 'Old', supportingDocuments: [] }]);
  const fresh = meeting([{ number: 1, agendaItemId: null, title: 'New', supportingDocuments: [] }]);
  const r = mergeWithExisting(stored, fresh);
  assert.equal(r.data.agendaItems[0].title, 'New');
});

// ---------------------------------------------------------------------------
// Change log: same-day runs merge
// ---------------------------------------------------------------------------

const desc = (id) => ({ agendaItemId: String(id), number: id, fileNumber: `CM-${id}`, shortTitle: `Item ${id}` });
const freshLog = () => ({ meetingId: '1', meetingDate: '2026-09-10', firstSeenAt: null, entries: [] });

test('a second same-day run with an empty diff does not erase the first run\'s entries', () => {
  const log = freshLog();
  appendOrMergeEntry(log, { scrapedAt: 't1', agendaTypePromoted: { from: 'DRAFT', to: 'FINAL' }, itemsAdded: [desc(5)], itemsRemoved: [] }, '2026-09-09');
  // 9 PM manual run: diff against the file the nightly wrote is empty, but
  // the mirror step logs a document.
  appendOrMergeEntry(log, { scrapedAt: 't2', agendaTypePromoted: null, itemsAdded: [], itemsRemoved: [], newDocuments: [{ itemNumber: 5, itemFileNumber: 'CM-5', filename: 'Memo.pdf' }] }, '2026-09-09');
  assert.equal(log.entries.length, 1);
  const e = log.entries[0];
  assert.deepEqual(e.agendaTypePromoted, { from: 'DRAFT', to: 'FINAL' });
  assert.deepEqual(e.itemsAdded.map((i) => i.agendaItemId), ['5']);
  assert.equal(e.scrapedAt, 't2');
  assert.equal(e.newDocuments.length, 1);
});

test('same-day additions accumulate and an add-then-remove nets out', () => {
  const log = freshLog();
  appendOrMergeEntry(log, { itemsAdded: [desc(1), desc(2)], itemsRemoved: [] }, '2026-09-09');
  appendOrMergeEntry(log, { itemsAdded: [desc(3)], itemsRemoved: [desc(2)] }, '2026-09-09');
  const e = log.entries[0];
  assert.deepEqual(e.itemsAdded.map((i) => i.agendaItemId).sort(), ['1', '3']);
  assert.deepEqual(e.itemsRemoved, [], 'item 2 was added and removed the same day');
});

test('a promotion that round-trips within a day cancels out', () => {
  const log = freshLog();
  appendOrMergeEntry(log, { agendaTypePromoted: { from: 'DRAFT', to: 'FINAL' } }, '2026-09-09');
  appendOrMergeEntry(log, { agendaTypePromoted: { from: 'FINAL', to: 'DRAFT' }, itemsAdded: [desc(9)] }, '2026-09-09');
  assert.equal(log.entries[0].agendaTypePromoted, null);
});

test('entries on different days stay separate and newest-first', () => {
  const log = freshLog();
  appendOrMergeEntry(log, { itemsAdded: [desc(1)] }, '2026-09-08');
  appendOrMergeEntry(log, { itemsAdded: [desc(2)] }, '2026-09-09');
  assert.deepEqual(log.entries.map((e) => e.date), ['2026-09-09', '2026-09-08']);
});

// ---------------------------------------------------------------------------
// Post title / slug
// ---------------------------------------------------------------------------

test('a generic evening meeting keeps the archive vocabulary', () => {
  assert.deepEqual(typeInfo({ meetingType: 'evening', meetingName: 'City Council Evening' }), { title: 'Evening Land Use', slug: 'evening-land-use' });
  assert.deepEqual(typeInfo({ meetingType: 'evening', meetingName: null }), { title: 'Evening Land Use', slug: 'evening-land-use' });
});

test('an evening session with a real clerk name uses it (9/8/26 budget hearing)', () => {
  assert.deepEqual(typeInfo({ meetingType: 'evening', meetingName: 'City Council Budget Public Hearing' }), { title: 'Budget Public Hearing', slug: 'budget-public-hearing' });
});

test('special meetings and weekly types are unchanged', () => {
  assert.deepEqual(typeInfo({ meetingType: 'special', meetingName: 'CRA Special Call' }), { title: 'CRA Special Call', slug: 'cra-special-call' });
  assert.deepEqual(typeInfo({ meetingType: 'special', meetingName: 'Council Special Call' }), { title: 'Special Call', slug: 'special-call' });
  assert.deepEqual(typeInfo({ meetingType: 'cra', meetingName: 'CRA Regular Session' }), { title: 'CRA', slug: 'cra' });
  assert.deepEqual(typeInfo({ meetingType: 'regular', meetingName: 'City Council Regular' }), { title: 'Regular Meeting', slug: 'regular-meeting' });
});

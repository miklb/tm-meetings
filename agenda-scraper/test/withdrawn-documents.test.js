// Withdrawn documents (lib/withdrawn-documents.js) — run with `npm test`.
// Pure logic plus one check of the real list file. Nothing touches R2.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LIST_PATH,
  FIELDS,
  loadWithdrawn,
  saveWithdrawn,
  keyFromUrl,
  itemDocumentKeys,
  applyWithdrawals,
  findDocument,
} = require('../lib/withdrawn-documents');
const { mergeWithExisting } = require('../lib/scrape-guard');
const { DocumentMirror } = require('../lib/document-mirror');

// The first real case: REZ-26-37's noticed-parties affidavit, meeting 2829.
const KEY = '2026-05-14/meeting-2829/23310/affidavit-of-compliance-rez26-37-05142026.pdf';
const ENTRY = {
  key: KEY,
  meetingId: 2829,
  agendaItemId: 23310,
  fileNumber: 'REZ-26-37',
  title: 'AFFIDAVIT OF COMPLIANCE REZ26-37 05142026.PDF',
  withdrawnOn: '2026-10-16',
  reason: 'privacy-request',
};
const LIST = { documents: [ENTRY] };

const onbase = (name, publishId) =>
  `https://tampagov.hylandcloud.com/251agendaonline/Documents/DownloadFileBytes/${encodeURIComponent(name)}.pdf?documentType=1&meetingId=2829&itemId=23310&publishId=${publishId}&isSection=False&isAttachment=True`;

function meeting() {
  return {
    meetingId: '2829',
    meetingDate: 'May 14, 2026',
    formattedDate: '2026-05-14',
    agendaItems: [
      {
        number: '7', agendaItemId: '23310', fileNumber: 'REZ-26-37', title: 'REZ-26-37', background: 'bg',
        supportingDocuments: [
          { title: 'REZ-26-37 CERTIFIED APP.PDF', url: onbase('REZ-26-37 CERTIFIED APP.PDF', 193939), mirroredUrl: 'https://docs.meetings.tampamonitor.com/2026-05-14/meeting-2829/23310/rez-26-37-certified-app.pdf' },
          { title: 'AFFIDAVIT OF COMPLIANCE REZ26-37 05142026.PDF', url: onbase('AFFIDAVIT OF COMPLIANCE REZ26-37 05142026.PDF', 193940), mirroredUrl: `https://docs.meetings.tampamonitor.com/${KEY}` },
          { title: 'REZ-26-37 FINAL SITE PLAN.PDF', url: onbase('REZ-26-37 FINAL SITE PLAN.PDF', 193941), mirroredUrl: 'https://docs.meetings.tampamonitor.com/2026-05-14/meeting-2829/23310/rez-26-37-final-site-plan.pdf' },
        ],
      },
      { number: '8', agendaItemId: '23311', fileNumber: 'REZ-26-38', title: 'REZ-26-38', background: 'bg', supportingDocuments: [] },
    ],
  };
}

function tmpList(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'withdrawn-'));
  const file = path.join(dir, 'withdrawn-documents.json');
  if (contents !== undefined) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('itemDocumentKeys recomputes the same key the mirror step stamped', () => {
  const m = meeting();
  const keys = itemDocumentKeys(m, m.agendaItems[0]);
  const stamped = m.agendaItems[0].supportingDocuments.map((d) => d.mirroredUrl.replace('https://docs.meetings.tampamonitor.com/', ''));
  assert.deepEqual(keys, stamped);
  assert.equal(keys[1], KEY);
});

test('itemDocumentKeys matches DocumentMirror.generateKey, repeats and all', () => {
  const mirror = new DocumentMirror({ endpoint: 'https://s3.test', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b', publicUrlBase: 'https://docs.test' });
  const m = { meetingId: '2564', meetingDate: 'January 8, 2026', agendaItems: [{ agendaItemId: '40', supportingDocuments: [
    { title: 'Exhibit A', url: 'https://x/DownloadFileBytes/a.PDF.pdf?publishId=1' },
    { title: 'EXHIBIT  A', url: 'https://x/DownloadFileBytes/a.PDF.pdf?publishId=2' },
    { title: 'Memo.DOCX', url: 'https://x/DownloadFileBytes/Memo.DO.pdf?publishId=5' },
  ] }] };
  assert.deepEqual(itemDocumentKeys(m, m.agendaItems[0]), [
    mirror.generateKey('2026-01-08', '2564', '40', 'Exhibit A'),
    mirror.generateKey('2026-01-08', '2564', '40', 'EXHIBIT  A-2'),
    mirror.generateKey('2026-01-08', '2564', '40', 'Memo.pdf'),
  ]);
});

test('keyFromUrl accepts the public URL or a bare key', () => {
  assert.equal(keyFromUrl(`https://docs.meetings.tampamonitor.com/${KEY}`), KEY);
  assert.equal(keyFromUrl(`https://docs.meetings.tampamonitor.com/${KEY}?x=1`), KEY);
  assert.equal(keyFromUrl(KEY), KEY);
});

test('findDocument locates the document by key', () => {
  const m = meeting();
  const found = findDocument(m, KEY);
  assert.equal(found.item.agendaItemId, '23310');
  assert.equal(found.index, 1);
  assert.equal(found.doc.title, ENTRY.title);
  assert.equal(findDocument(m, '2026-05-14/meeting-2829/23310/nope.pdf'), null);
});

// ---------------------------------------------------------------------------
// Applying the list
// ---------------------------------------------------------------------------

test('applyWithdrawals stamps the listed document and drops only its mirroredUrl', () => {
  const m = meeting();
  const r = applyWithdrawals(m, LIST);
  assert.deepEqual(r, { withdrawn: 1, changed: 1 });
  const [app, affidavit, plan] = m.agendaItems[0].supportingDocuments;
  assert.deepEqual(affidavit.withdrawn, { on: '2026-10-16', reason: 'privacy-request' });
  assert.equal(affidavit.mirroredUrl, undefined);
  assert.equal(affidavit.url, onbase('AFFIDAVIT OF COMPLIANCE REZ26-37 05142026.PDF', 193940), 'the City link stays');
  assert.ok(app.mirroredUrl && plan.mirroredUrl, 'neighbours untouched');
  assert.equal(app.withdrawn, undefined);
});

test('applyWithdrawals is idempotent and reports no change the second time', () => {
  const m = meeting();
  applyWithdrawals(m, LIST);
  assert.deepEqual(applyWithdrawals(m, LIST), { withdrawn: 1, changed: 0 });
});

test('applyWithdrawals clears a stale stamp when the entry is removed (reversal)', () => {
  const m = meeting();
  applyWithdrawals(m, LIST);
  const r = applyWithdrawals(m, { documents: [] });
  assert.deepEqual(r, { withdrawn: 0, changed: 1 });
  assert.equal(m.agendaItems[0].supportingDocuments[1].withdrawn, undefined);
});

test('applyWithdrawals works from meetingDate alone (one 2025 file has no formattedDate)', () => {
  const m = meeting();
  delete m.formattedDate;
  assert.equal(applyWithdrawals(m, LIST).withdrawn, 1);
});

test('applyWithdrawals tolerates an empty list and a malformed meeting', () => {
  assert.deepEqual(applyWithdrawals(meeting(), { documents: [] }), { withdrawn: 0, changed: 0 });
  assert.deepEqual(applyWithdrawals(null, LIST), { withdrawn: 0, changed: 0 });
});

// ---------------------------------------------------------------------------
// Re-scrape: the stamp survives, the mirror link does not come back
// ---------------------------------------------------------------------------

test('scrape-guard carries a withdrawn stamp forward and never restores its mirroredUrl', () => {
  const stored = meeting();
  applyWithdrawals(stored, LIST);
  const fresh = meeting();
  // a fresh scrape has no stamps of any kind
  for (const d of fresh.agendaItems[0].supportingDocuments) delete d.mirroredUrl;
  const r = mergeWithExisting(stored, fresh);
  assert.equal(r.refused, null);
  const docs = r.data.agendaItems[0].supportingDocuments;
  assert.deepEqual(docs[1].withdrawn, { on: '2026-10-16', reason: 'privacy-request' });
  assert.equal(docs[1].mirroredUrl, undefined);
  assert.ok(docs[0].mirroredUrl && docs[2].mirroredUrl, 'the other stamps are restored');
  assert.equal(r.restoredMirrors, 2);
});

test('scrape-guard drops a mirroredUrl a fresh scrape would hand a withdrawn document', () => {
  const stored = meeting();
  applyWithdrawals(stored, LIST);
  const fresh = meeting(); // still carries the old mirroredUrl on the affidavit
  const r = mergeWithExisting(stored, fresh);
  assert.equal(r.data.agendaItems[0].supportingDocuments[1].mirroredUrl, undefined);
});

// ---------------------------------------------------------------------------
// The list file: schema is the no-names rule
// ---------------------------------------------------------------------------

test('loadWithdrawn: a missing file is an empty list', () => {
  assert.deepEqual(loadWithdrawn(tmpList()), { documents: [] });
});

test('loadWithdrawn round-trips a valid entry', () => {
  const file = tmpList();
  saveWithdrawn(LIST, file);
  assert.deepEqual(loadWithdrawn(file), LIST);
});

test('loadWithdrawn refuses any field outside the schema (who asked never goes in the list)', () => {
  for (const extra of [{ requester: 'J. Doe' }, { address: '1313 W Nassau St' }, { note: 'called 10/16' }, { email: 'x@y' }]) {
    const file = tmpList({ documents: [{ ...ENTRY, ...extra }] });
    assert.throws(() => loadWithdrawn(file), /unexpected field/, Object.keys(extra)[0]);
  }
});

test('loadWithdrawn refuses a reason outside the vocabulary, a bad key, a bad date, a duplicate', () => {
  assert.throws(() => loadWithdrawn(tmpList({ documents: [{ ...ENTRY, reason: 'asked nicely' }] })), /reason must be one of/);
  assert.throws(() => loadWithdrawn(tmpList({ documents: [{ ...ENTRY, key: `https://docs.meetings.tampamonitor.com/${KEY}` }] })), /key must be an R2 key/);
  assert.throws(() => loadWithdrawn(tmpList({ documents: [{ ...ENTRY, withdrawnOn: '10/16/26' }] })), /withdrawnOn/);
  assert.throws(() => loadWithdrawn(tmpList({ documents: [{ ...ENTRY, agendaItemId: 99 }] })), /does not belong/);
  assert.throws(() => loadWithdrawn(tmpList({ documents: [ENTRY, ENTRY] })), /duplicate key/);
  assert.throws(() => loadWithdrawn(tmpList({ documents: [(({ title, ...rest }) => rest)(ENTRY)] })), /missing title/);
  assert.throws(() => loadWithdrawn(tmpList({ withdrawn: [] })), /expected/);
});

test('the real data/withdrawn-documents.json validates', () => {
  const list = loadWithdrawn(LIST_PATH);
  assert.ok(Array.isArray(list.documents));
  for (const entry of list.documents) assert.deepEqual(Object.keys(entry).sort(), [...FIELDS].sort());
});

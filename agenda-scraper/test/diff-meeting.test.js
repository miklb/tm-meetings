// lib/diff-meeting.js — the structured diff json-scraper.js writes to the
// public per-meeting change log — and the is-new chip the agenda post draws
// from that log. Run with `npm test`.
//
// Documents pair by title and count copies: on 10/26/26 a revised memo landed
// under the original's exact filename (meeting 2989) and the change log
// recorded nothing. Logged, it must badge the new link, not both.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMeetingDiff, diffIsEmpty, pairDocumentsByTitle } = require('../lib/diff-meeting');
const { appendOrMergeEntry } = require('../lib/change-log');
const { collectNewDocKeys, newDocumentFlags } = require('../json-to-markdown');

const doc = (title, publishId) => ({ title, url: `https://example.test/${title}?publishId=${publishId}` });
const item = (agendaItemId, supportingDocuments) => ({
  number: 1, agendaItemId, fileNumber: '', title: 'Item', supportingDocuments,
});
const meeting = (agendaItems) => ({ agendaType: 'FINAL', agendaItems });

test('a second copy under an existing title is logged as added', () => {
  const before = meeting([item('28272', [doc('MEMO.PDF', 217097)])]);
  const after = meeting([item('28272', [doc('MEMO.PDF', 217130), doc('MEMO.PDF', 217131)])]);
  const diff = computeMeetingDiff(before, after);
  assert.equal(diffIsEmpty(diff), false);
  assert.deepEqual(diff.documentsAdded, [{ itemNumber: 1, itemFileNumber: '', filename: 'MEMO.PDF', copy: 2 }]);
});

test('a new title carries no copy number', () => {
  const before = meeting([item('10', [doc('A', 1)])]);
  const after = meeting([item('10', [doc('A', 101), doc('B', 102)])]);
  assert.deepEqual(computeMeetingDiff(before, after).documentsAdded, [{ itemNumber: 1, itemFileNumber: '', filename: 'B' }]);
});

test('the second copy is logged and badged alone', () => {
  const memo = 'MEMO.PDF';
  const before = meeting([item('28272', [doc(memo, 217097)])]);
  const after = meeting([item('28272', [doc(memo, 217130), doc(memo, 217131)])]);
  const log = { meetingId: '2989', meetingDate: '2026-10-29', firstSeenAt: null, entries: [] };
  appendOrMergeEntry(log, { newDocuments: computeMeetingDiff(before, after).documentsAdded }, '2026-10-26');
  assert.equal(log.entries[0].newDocuments.length, 1);
  assert.deepEqual(newDocumentFlags(after.agendaItems[0], collectNewDocKeys(log)), [false, true]);
});

test('a logged first copy does not swallow a later second copy', () => {
  const log = { entries: [] };
  appendOrMergeEntry(log, { newDocuments: [{ itemNumber: 1, itemFileNumber: '', filename: 'A.pdf' }] }, '2026-10-01');
  appendOrMergeEntry(log, { newDocuments: [{ itemNumber: 1, itemFileNumber: '', filename: 'A.pdf', copy: 2 }] }, '2026-10-05');
  assert.equal(log.entries.length, 2);
});

test('an entry without a copy number badges every link under its title, as before', () => {
  const it = item('10', [doc('A', 1), doc('A', 2), doc('B', 3)]);
  const log = { entries: [{ newDocuments: [{ itemNumber: 1, filename: 'A' }] }] };
  assert.deepEqual(newDocumentFlags(it, collectNewDocKeys(log)), [true, true, false]);
});

test('rotated URLs alone add nothing', () => {
  const before = meeting([item('10', [doc('A', 1), doc('A', 2), doc('B', 3)])]);
  const after = meeting([item('10', [doc('A', 101), doc('A', 102), doc('B', 103)])]);
  assert.equal(diffIsEmpty(computeMeetingDiff(before, after)), true);
});

test('copies pair in page order; the surplus is the change', () => {
  const a1 = doc('A', 1);
  const a2 = doc('A', 2);
  const b = doc('B', 3);
  const { added, removed, matched } = pairDocumentsByTitle([a1, a2, b], [doc('a ', 101), b]);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, [a2]);
  assert.equal(matched.length, 2);
  assert.equal(matched[0][0], a1); // whitespace and case don't split a title
});

// diff-without-urls.js --summary — what the nightly issue says about a
// modified meeting. Run with `npm test`.
//
// The publishId note must count URLs that actually moved, not every document
// matched by title: on 10/12/26 lib/scrape-guard.js wrote nine of meeting
// 2935's items back unchanged and the issue still said "83 document URLs
// changed" when 13 had.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'diff-without-urls.js');

const doc = (title, publishId) => ({
  title,
  url: `https://tampagov.hylandcloud.com/251agendaonline/Documents/DownloadFileBytes/${encodeURIComponent(title)}.pdf?documentType=1&meetingId=1&itemId=1&publishId=${publishId}&isSection=False&isAttachment=True`,
});
const item = (agendaItemId, fileNumber, supportingDocuments) => ({
  number: 1, agendaItemId, fileNumber, title: fileNumber, supportingDocuments,
});
const meeting = (agendaItems) => ({ meetingId: '1', agendaType: 'FINAL', agendaItems });

function summary(oldData, newData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-without-urls-'));
  const oldFile = path.join(dir, 'old.json');
  const newFile = path.join(dir, 'new.json');
  fs.writeFileSync(oldFile, JSON.stringify(oldData));
  fs.writeFileSync(newFile, JSON.stringify(newData));
  const out = execFileSync(process.execPath, [SCRIPT, '--summary', oldFile, newFile], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('a full republish counts every rotated URL', () => {
  const before = meeting([item('10', 'REZ-26-1', [doc('A', 1), doc('B', 2)])]);
  const after = meeting([item('10', 'REZ-26-1', [doc('A', 101), doc('B', 102), doc('C', 103)])]);
  const out = summary(before, after);
  assert.match(out, /New documents:/);
  assert.match(out, /2 of 2 document URLs changed/);
});

test('items the guard wrote back do not count as rotated', () => {
  // The 10/12/26 shape: item 1 republished, item 2 lost a document, item 3 kept.
  const before = meeting([
    item('10', 'REZ-26-1', [doc('A', 1), doc('B', 2)]),
    item('11', 'REZ-26-2', [doc('C', 3), doc('D', 4)]),
    item('12', 'REZ-26-3', [doc('E', 5), doc('F', 6)]),
  ]);
  const after = meeting([
    item('10', 'REZ-26-1', [doc('A', 101), doc('B', 102)]),
    item('11', 'REZ-26-2', [doc('C', 103)]),
    item('12', 'REZ-26-3', [doc('E', 5), doc('F', 6)]),
  ]);
  const out = summary(before, after);
  assert.match(out, /Removed documents:/);
  assert.match(out, /REZ-26-2 \(agendaItemId=11\): 1 document removed/);
  assert.match(out, /3 of 5 document URLs changed/);
});

test('no note when nothing rotated', () => {
  const before = meeting([item('10', 'REZ-26-1', [doc('A', 1)])]);
  const after = meeting([item('10', 'REZ-26-1', [doc('A', 1), doc('B', 2)])]);
  const out = summary(before, after);
  assert.match(out, /New documents:/);
  assert.doesNotMatch(out, /document URLs changed/);
});

test('a second copy under an existing title is a new document', () => {
  // The 10/26/26 shape (meeting 2989): the clerk republished the item with
  // the revised memo attached under the original's exact filename. The
  // nightly said "No meaningful changes" and opened no issue.
  const memo = 'MEMO RE RAYS COMMUNITY BENEFITS AGREEMENT (CBA).PDF';
  const before = meeting([item('28272', null, [doc(memo, 217097)])]);
  const after = meeting([item('28272', null, [doc(memo, 217130), doc(memo, 217131)])]);
  const out = summary(before, after);
  assert.match(out, /agendaItemId=28272 \(agendaItemId=28272\): 1 new document\b/);
  assert.match(out, /copies under this title: 1 → 2/);
  assert.match(out, /1 of 1 document URLs changed/);
});

test('losing one of two same-titled copies is a removal', () => {
  const before = meeting([item('10', 'REZ-26-1', [doc('A', 1), doc('A', 2)])]);
  const after = meeting([item('10', 'REZ-26-1', [doc('A', 1)])]);
  const out = summary(before, after);
  assert.match(out, /REZ-26-1 \(agendaItemId=10\): 1 document removed/);
  assert.match(out, /copies under this title: 2 → 1/);
});

test('same-titled copies that only rotated are still churn', () => {
  const before = meeting([item('10', 'REZ-26-1', [doc('A', 1), doc('A', 2)])]);
  const after = meeting([item('10', 'REZ-26-1', [doc('A', 101), doc('A', 102)])]);
  assert.match(summary(before, after), /No meaningful changes/);
});

test('URL-only churn is still suppressed', () => {
  const before = meeting([item('10', 'REZ-26-1', [doc('A', 1)])]);
  const after = meeting([item('10', 'REZ-26-1', [doc('A', 101)])]);
  assert.match(summary(before, after), /No meaningful changes/);
});

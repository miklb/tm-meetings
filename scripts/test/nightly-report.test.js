// nightly-report.sh — which scraper log lines open an issue. Run with `npm test`.
//
// The script reads `git diff --staged`; GIT_INDEX_FILE points at a file that
// does not exist so the staged diff is empty and only the log lines matter.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'nightly-report.sh');

function runReport(logLines, { stored = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-report-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  for (const name of stored) fs.writeFileSync(path.join(dataDir, name), '{}');
  const log = path.join(dir, 'scrape.log');
  fs.writeFileSync(log, logLines.join('\n') + '\n');
  const out = path.join(dir, 'issue-body.md');
  const stdout = execFileSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      GIT_INDEX_FILE: path.join(dir, 'no-such-index'),
      GITHUB_OUTPUT: '',
      SCRAPE_LOG: log,
      SCRAPE_OUTCOME: 'success',
      VRB_LOG: path.join(dir, 'no-vrb.log'),
      VRB_OUTCOME: 'success',
      OUT: out,
      DATA_DIR: dataDir,
    },
    encoding: 'utf8',
  });
  const meaningful = /has_meaningful=true/.test(stdout);
  const body = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { meaningful, body };
}

const unavailable = (id) => `[HTTP] Meeting ${id} is not available on the server — skipping.`;

test('a past meeting we already hold going unavailable does not open an issue', () => {
  // Meeting 2935 (10/8/26 evening) stayed on the city list after its page
  // was pulled; the nightly opened an issue every night from 10/9 to 10/11.
  const r = runReport([unavailable(2935)], { stored: ['meeting_2935_2000-01-01.json'] });
  assert.equal(r.meaningful, false);
  assert.equal(r.body, '');
});

test('a meeting we never captured going unavailable still opens an issue', () => {
  const r = runReport([unavailable(4242)]);
  assert.equal(r.meaningful, true);
  assert.match(r.body, /Unavailable Meetings/);
  assert.match(r.body, /Meeting \*\*4242\*\*/);
});

test('a stored meeting still ahead on the calendar going unavailable opens an issue', () => {
  const r = runReport([unavailable(4343)], { stored: ['meeting_4343_2099-01-01.json'] });
  assert.equal(r.meaningful, true);
  assert.match(r.body, /Meeting \*\*4343\*\*/);
});

test('an already archived meeting is listed for the record when something else opens the issue', () => {
  const r = runReport(
    [unavailable(2935), '[HTTP] ⚠️  Skipping meeting 4444 after error: socket hang up'],
    { stored: ['meeting_2935_2000-01-01.json'] }
  );
  assert.equal(r.meaningful, true);
  assert.match(r.body, /failed to scrape/);
  assert.match(r.body, /Meeting \*\*4444\*\*: socket hang up/);
  assert.match(r.body, /already archived/);
  assert.match(r.body, /Meeting \*\*2935\*\* \(2000-01-01\)/);
  assert.doesNotMatch(r.body, /### ⚠️ Unavailable Meetings/);
});

// --- scrape guard passthrough -------------------------------------------
// json-scraper.js logs "Meeting N: kept stored version of item M (...)" when
// lib/scrape-guard.js writes a stored item back. The issue must say so: on
// 10/12/26 meeting 2935 came back from the city mid-republish, the guard held
// nine items, and the issue only showed "7 documents removed" on a tenth.

const kept = (id, n, docs) => `Meeting ${id}: kept stored version of item ${n} (all ${docs} documents missing)`;

test('guard holding items does not open an issue by itself', () => {
  const r = runReport([kept(2935, 4, 7), kept(2935, 5, 6)], { stored: ['meeting_2935_2000-01-01.json'] });
  assert.equal(r.meaningful, false);
  assert.equal(r.body, '');
});

test('guard-held items are listed for the record when something else opens the issue', () => {
  const r = runReport(
    [kept(2935, 4, 7), kept(2935, 5, 6), '[HTTP] ⚠️  Skipping meeting 4444 after error: socket hang up'],
    { stored: ['meeting_2935_2000-01-01.json'] }
  );
  assert.equal(r.meaningful, true);
  assert.match(r.body, /### Scrape guard kept stored items \(informational\)/);
  assert.match(r.body, /Meeting \*\*2935\*\* \(2000-01-01\) — stored items written back/);
  assert.match(r.body, /  - item 4 \(all 7 documents missing\)/);
  assert.match(r.body, /  - item 5 \(all 6 documents missing\)/);
});

// A real staged change: a throwaway git repo holding copies of the script
// and diff-without-urls.js, the old meeting file committed, the new one staged.
const doc = (title, publishId) => ({
  title,
  url: `https://tampagov.hylandcloud.com/251agendaonline/Documents/DownloadFileBytes/${encodeURIComponent(title)}.pdf?publishId=${publishId}`,
});
const item = (agendaItemId, fileNumber, supportingDocuments) => ({ number: 1, agendaItemId, fileNumber, title: fileNumber, supportingDocuments });
const meeting = (agendaItems) => ({ meetingId: '2935', agendaType: 'FINAL', agendaItems });

function runReportWithStagedChange(oldData, newData, logLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-report-repo-'));
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'agenda-scraper', 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agenda-scraper', 'lib'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'nightly-report.sh'));
  for (const rel of ['diff-without-urls.js', 'lib/diff-meeting.js']) {
    fs.copyFileSync(path.join(__dirname, '..', '..', 'agenda-scraper', rel), path.join(dir, 'agenda-scraper', rel));
  }
  const file = path.join(dir, 'agenda-scraper', 'data', 'meeting_2935_2026-10-08.json');
  git('init', '-q');
  fs.writeFileSync(file, JSON.stringify(oldData));
  git('add', '-A');
  git('commit', '-q', '-m', 'old');
  fs.writeFileSync(file, JSON.stringify(newData));
  git('add', '-A');
  const log = path.join(dir, 'scrape.log');
  fs.writeFileSync(log, logLines.join('\n') + '\n');
  const out = path.join(dir, 'issue-body.md');
  const stdout = execFileSync('bash', [path.join(dir, 'scripts', 'nightly-report.sh')], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: '',
      SCRAPE_LOG: log,
      SCRAPE_OUTCOME: 'success',
      VRB_LOG: path.join(dir, 'no-vrb.log'),
      VRB_OUTCOME: 'success',
      OUT: out,
      DATA_DIR: path.join(dir, 'agenda-scraper', 'data'),
    },
    encoding: 'utf8',
  });
  const meaningful = /has_meaningful=true/.test(stdout);
  const body = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { meaningful, body };
}

test('a modified meeting shows the items the guard held right under its changes', () => {
  // The 10/12/26 shape: item 1 republished, item 2 lost a document, item 3 held.
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
  const r = runReportWithStagedChange(before, after, [kept(2935, 3, 2)]);
  assert.equal(r.meaningful, true);
  assert.match(r.body, /### Meeting 2935 \(2026-10-08\)/);
  assert.match(r.body, /REZ-26-2 \(agendaItemId=11\): 1 document removed/);
  assert.match(r.body, /3 of 5 document URLs changed/);
  assert.match(r.body, /\*\*Scrape guard kept stored items\*\* — the fresh scrape returned these without documents/);
  assert.match(r.body, /  - item 3 \(all 2 documents missing\)/);
  assert.doesNotMatch(r.body, /Scrape guard kept stored items \(informational\)/);
});

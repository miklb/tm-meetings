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

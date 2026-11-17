// json-to-markdown.js leaves a published agenda post alone once its meeting
// date has passed. Post-meeting sweeps (archive-meeting.sh Step 0) re-run the
// whole agenda pipeline; they used to rewrite the tm-static post and drop hand
// edits to its front matter (an `updated:` line on 11/5/26). Run with `npm test`.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { postIsFrozen, writePost } = require('../json-to-markdown');

const post = {
  title: '11/5/26 - Regular Meeting',
  slug: '11-5-26-regular-meeting',
  fileStem: '11-5-26-regular-meeting',
  excerpt: 'Agenda.',
  hasMap: false,
  meetingDate: '2026-11-05',
  body: '<p>regenerated body</p>',
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-post-'));
  const destDir = path.join(root, 'posts');
  const recordDir = path.join(root, 'agendas');
  fs.mkdirSync(path.join(destDir, '2026'), { recursive: true });
  fs.mkdirSync(recordDir);
  const postPath = path.join(destDir, '2026', '11-5-26-regular-meeting.md');
  const published = '---\ndate: 2026-11-01T08:20:37-05:00\nupdated: 2026-11-04T18:29:21-05:00\n---\n\n<p>published body</p>\n';
  fs.writeFileSync(postPath, published);
  return { destDir, recordDir, postPath, published };
}

test('a meeting is frozen only after its date', () => {
  assert.equal(postIsFrozen('2026-11-05', '2026-11-04'), false);
  assert.equal(postIsFrozen('2026-11-05', '2026-11-05'), false, 'meeting day still updates');
  assert.equal(postIsFrozen('2026-11-05', '2026-11-06'), true);
  assert.equal(postIsFrozen(undefined, '2026-11-06'), false);
});

test('after the meeting, the published post is untouched but the record is written', () => {
  const { destDir, recordDir, postPath, published } = setup();
  writePost(post, destDir, { today: '2026-11-14', recordDir });
  assert.equal(fs.readFileSync(postPath, 'utf8'), published);
  assert.match(fs.readFileSync(path.join(recordDir, 'agenda_2026-11-05.md'), 'utf8'), /regenerated body/);
});

test('--force rewrites a past post and keeps its publish date', () => {
  const { destDir, recordDir, postPath } = setup();
  writePost(post, destDir, { today: '2026-11-14', recordDir, force: true });
  const out = fs.readFileSync(postPath, 'utf8');
  assert.match(out, /regenerated body/);
  assert.match(out, /^date: 2026-11-01T08:20:37-05:00$/m);
});

test('before the meeting, re-runs still update the post', () => {
  const { destDir, recordDir, postPath } = setup();
  writePost(post, destDir, { today: '2026-11-04', recordDir });
  assert.match(fs.readFileSync(postPath, 'utf8'), /regenerated body/);
});

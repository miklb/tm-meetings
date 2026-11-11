// notify.js — the pieces that decide what gets sent where. Run with `npm test`.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  meetingIdsForDate, agendaUrlFromRecord, missingAnchors,
  parsePreviewCount, parseSentCount, readSecret,
} = require('../notify.js');

test('meetingIdsForDate picks only that date, lowest id first', () => {
  const files = [
    'meeting_3000_2026-11-05.json',
    'meeting_2940_2026-11-12.json',
    'meeting_2939_2026-11-12.json',
    'meeting_2939_2026-11-12.json.bak',
    'vrb',
  ];
  assert.deepEqual(meetingIdsForDate(files, '2026-11-12'), ['2939', '2940']);
  assert.deepEqual(meetingIdsForDate(files, '2026-11-19'), []);
});

test('agendaUrlFromRecord reads the permalink, quoted or not', () => {
  const quoted = '---\ntitle: "x"\npermalink: "/tampa-city-council/agendas/11-12-26-cra/"\n---\n';
  const bare = '---\npermalink: /tampa-city-council/agendas/11-12-26-cra/\n---\n';
  const url = 'https://tampamonitor.com/tampa-city-council/agendas/11-12-26-cra/';
  assert.equal(agendaUrlFromRecord(quoted), url);
  assert.equal(agendaUrlFromRecord(bare), url);
  assert.equal(agendaUrlFromRecord('---\ntitle: "x"\n---\n'), null);
});

test('missingAnchors lists items the post has no anchor for', () => {
  const html = '<li id="item-27918">one</li><li id="item-279320">not 27932</li>';
  const meetings = [
    { agendaItems: [{ number: '1', fileNumber: 'REZ-26-41', agendaItemId: 27918 }] },
    { agendaItems: [{ number: '2', fileNumber: 'REZ-26-83', agendaItemId: 27932 }] },
    {},
  ];
  assert.deepEqual(missingAnchors(html, meetings), [{ number: '2', fileNumber: 'REZ-26-83' }]);
});

test('parsePreviewCount reads the summary, the empty case, and nothing else', () => {
  assert.equal(parsePreviewCount('Summary: dispatch would send 5 email(s) (expect "sentCount":5).'), 5);
  assert.equal(parsePreviewCount('Summary: dispatch would send 0 email(s) (expect "sentCount":0).'), 0);
  assert.equal(parsePreviewCount('No verified subscribers meet the requirements. Nothing would send.'), 0);
  assert.equal(parsePreviewCount('Reading remote D1 (read-only)...'), null);
});

test('parseSentCount reads the server response', () => {
  assert.equal(parseSentCount('Response: 200 \n{"success":true,"sentCount":5,"matchesLogged":28}'), 5);
  assert.equal(parseSentCount('Response: 500 \n{"error":"x"}'), null);
});

test('readSecret takes the value as written, minus wrapping quotes', () => {
  assert.equal(readSecret('A=1\nWEBHOOK_SECRET=abc=def\nB=2\n'), 'abc=def');
  assert.equal(readSecret('WEBHOOK_SECRET="abc"\n'), 'abc');
  assert.equal(readSecret('OTHER=1\n'), null);
});

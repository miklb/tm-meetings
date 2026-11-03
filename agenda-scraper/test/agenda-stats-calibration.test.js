// Holds computeAgendaStats to figures Michael published by hand, against the
// scraped meetings themselves. If a parser or bucket change moves one of these,
// either the change is wrong or the published figure needs a second look.
//
// Only figures the code reproduces exactly are pinned. Hand totals that can't be
// rebuilt from the data, and editorial choices in a range (a dog "valued at
// $12,000" as the low end, 7/31/25), are left out. So are upcoming agendas: the
// nightly scrape can change them under the test.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { computeAgendaStats } = require('../lib/agenda-stats');

const DATA = path.join(__dirname, '..', 'data');
const load = (id, date) => computeAgendaStats(JSON.parse(fs.readFileSync(path.join(DATA, `meeting_${id}_${date}.json`), 'utf8')));

test('8/28/25: "Contracts range from $14,698 ... to $81,546,855"', () => {
  // Both ends were invisible to the old parser: no marker, and an amount over two codes.
  const s = load(2516, '2025-08-28');
  assert.equal(s.range.smallest.amount, 14698);
  assert.equal(s.range.largest.amount, 81546855);
});

test('12/4/25: "58 require a vote ... ranging from a $37,816.08 amendment ... to $52,935,137"', () => {
  const s = load(2713, '2025-12-04');
  assert.equal(s.voteCount, 58);
  assert.equal(s.itemCount, 65);
  assert.equal(s.range.smallest.amount, 37816.08);
  assert.equal(s.range.largest.amount, 52935137);
});

test('2/5/26: "a 62 item agenda; 50 requiring a vote"', () => {
  const s = load(2672, '2026-02-05');
  assert.equal(s.itemCount, 62);
  assert.equal(s.voteCount, 50);
});

test('5/21/26: "funding that range from $5,000 to $30 million"', () => {
  const s = load(2839, '2026-05-21');
  assert.equal(s.range.smallest.amount, 5000);
  assert.equal(s.range.largest.amount, 30000000);
});

test('6/4/26: "accepting a $2,000 grant ... to a $12 million budget realignment"', () => {
  const s = load(2833, '2026-06-04');
  assert.equal(s.range.smallest.amount, 2000);
  assert.equal(Math.max(...s.reallocation.items.map((i) => i.amount)), 12661043);
});

test('7/16/26: "$2,000.00 grant ... to item 80 $17,413,638.73 ... reallocating $43,306,896.72"', () => {
  const s = load(2815, '2026-07-16');
  assert.equal(s.itemCount, 95);
  assert.equal(s.range.smallest.amount, 2000);
  assert.equal(s.range.smallest.number, 14);
  assert.equal(s.range.largest.amount, 17413638.73);
  assert.equal(s.range.largest.number, 80);
  assert.equal(Math.max(...s.reallocation.items.map((i) => i.amount)), 43306896.72);
  // Item 79's sheet lists account codes with no amounts. It's flagged and left out,
  // which puts the total within 1% of the published $37,176,905.86, a post that
  // doesn't mention it.
  assert.deepEqual(s.spending.flagged, [79]);
  assert.deepEqual(s.range.unsettled, []);
  assert.ok(Math.abs(s.spending.total - 37176905.86) / 37176905.86 < 0.01, String(s.spending.total));
});

test('9/3/26: the South Howard parts count once and the reimbursement stays out', () => {
  const s = load(2882, '2026-09-03');
  const group = s.linked.find((l) => l.items.includes(36));
  assert.deepEqual(group.items, [36, 37, 38]);
  assert.equal(group.amount, 92712980.91);
  assert.ok(s.debt.items.some((d) => d.number === 39 && d.amount === 26000000));
});

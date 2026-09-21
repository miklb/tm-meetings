#!/usr/bin/env node
/**
 * One-time repair: plan amendments stored with the bare file number "TA/CPA".
 *
 * Until 2026-09-22 extractFileNumber stopped at "TA/CPA" when the clerk typed
 * the case number after a space ("File No. TA/CPA 26-05"), so every such item
 * lost its number: 16 items in 8 meetings, August 2025 onward. The extractor
 * is fixed for new scrapes; held meetings are never re-scraped, so this
 * re-derives the number from each item's own text. Safe: it changes only the
 * `fileNumber` of items whose stored value is exactly "TA/CPA", and only when
 * the text yields a full number.
 *
 * Usage: node scripts/backfill-plan-amendment-numbers.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { extractFileNumber } = require('../json-scraper');

const DATA_DIR = path.join(__dirname, '..', 'data');
const dryRun = process.argv.includes('--dry-run');

let fixed = 0;
for (const name of fs.readdirSync(DATA_DIR).filter((f) => /^meeting_\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
  const file = path.join(DATA_DIR, name);
  const raw = fs.readFileSync(file, 'utf8');
  const meeting = JSON.parse(raw);
  const changes = [];

  for (const item of meeting.agendaItems || []) {
    if (item.fileNumber !== 'TA/CPA') continue;
    const found = extractFileNumber(item.rawTitle || item.title || '');
    if (!found || found === 'TA/CPA' || !/^TA\/CPA\d/.test(found)) continue;
    changes.push(`item ${item.number}: TA/CPA → ${found}`);
    item.fileNumber = found;
  }

  if (!changes.length) continue;
  fixed += changes.length;
  console.log(`${name}\n  ${changes.join('\n  ')}`);
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(meeting, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
}
console.log(`${dryRun ? 'would fix' : 'fixed'} ${fixed} item(s)`);

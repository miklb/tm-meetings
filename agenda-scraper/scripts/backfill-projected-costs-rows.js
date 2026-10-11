#!/usr/bin/env node
/**
 * Re-derive PROJECTED COSTS rows from each item's stored section text.
 *
 * Until 2026-10-11 the account-code regex in lib/projected-costs-parser.js
 * only knew fund.dept.object[.project]. Summary Sheets also write a 0000
 * program placeholder before the project ("31400.243000.560005.0000.1000576"),
 * a trailing 0000000 task placeholder, and hyphen separators. Those rows
 * either lost their project segment or were dropped. The parser is fixed for
 * new scrapes; held meetings are never re-scraped, so this re-parses the
 * `projectedCostsRaw` text every item already stores.
 *
 * Only items whose account codes or row count change are rewritten. Items
 * whose rows differ in some other field (older parser versions normalised
 * markers and descriptions differently) are counted and left alone unless
 * --all is given.
 *
 * Usage: node scripts/backfill-projected-costs-rows.js [--dry-run] [--all]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseProjectedCostsRows } = require('../lib/projected-costs-parser');

const DATA_DIR = path.join(__dirname, '..', 'data');
const dryRun = process.argv.includes('--dry-run');
const writeAll = process.argv.includes('--all');

const codesOf = (rows) => rows.map((r) => r.accountCode).join(' | ');

let codeChanged = 0;
let otherChanged = 0;
let otherExample = null;
let filesTouched = 0;

for (const name of fs.readdirSync(DATA_DIR).filter((f) => /^meeting_\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
  const file = path.join(DATA_DIR, name);
  const raw = fs.readFileSync(file, 'utf8');
  const meeting = JSON.parse(raw);
  const changes = [];

  for (const item of meeting.agendaItems || []) {
    const pc = item.projectedCosts;
    if (!pc || !pc.projectedCostsRaw) continue;
    const before = pc.rows || [];
    const after = parseProjectedCostsRows(pc.projectedCostsRaw);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;

    const codesBefore = codesOf(before);
    const codesAfter = codesOf(after);
    const isCodeChange = codesBefore !== codesAfter || before.length !== after.length;
    if (!isCodeChange) {
      otherChanged += 1;
      if (!otherExample) otherExample = `${name} item ${item.number} ${item.fileNumber}`;
      if (!writeAll) continue;
    } else {
      codeChanged += 1;
      changes.push(`item ${item.number} ${item.fileNumber}: ${before.length}→${after.length} rows\n      ${codesBefore || '(none)'}\n   →  ${codesAfter || '(none)'}`);
    }
    pc.rows = after;
    pc.hasParsedRows = after.length > 0;
    if (!isCodeChange) changes.push(`item ${item.number} ${item.fileNumber}: non-code fields only`);
  }

  if (!changes.length) continue;
  filesTouched += 1;
  console.log(`${name}\n  ${changes.join('\n  ')}`);
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(meeting, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
}

console.log(`\n${dryRun ? 'would rewrite' : 'rewrote'} ${codeChanged} item(s) with changed codes in ${filesTouched} file(s)`);
if (otherChanged) {
  console.log(`${otherChanged} item(s) differ only in non-code fields${writeAll ? ' (rewritten, --all)' : ' (left alone; first: ' + otherExample + ')'}`);
}

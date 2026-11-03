#!/usr/bin/env node
/**
 * Print the counts and dollar figures for an agenda's intro, with the audit trail
 * behind them. Read-only: it reads meeting JSON and writes nothing.
 *
 *   node agenda-stats.js --date 2026-11-05
 *   node agenda-stats.js --date 2026-11-05 --meeting 2938
 *   node agenda-stats.js --date 2026-11-05 --json
 *
 * With no --meeting it reports the date's largest agenda and names the others
 * (evening sessions, addenda), since an addendum is its own meeting record.
 */

const fs = require('fs');
const path = require('path');
const { computeAgendaStats } = require('./lib/agenda-stats');

const DATA_DIR = path.join(__dirname, 'data');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const money = (n) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

const shortTitle = (s, len = 90) => {
  const t = String(s).replace(/^File No\.\s*\S+\s*/i, '').replace(/\(Part \d+ of \d+\)\s*\(See[^)]*\)\s*/i, '');
  return t.length > len ? `${t.slice(0, len - 1)}…` : t;
};

function itemLine(i) {
  const tags = [];
  if (i.closeout) tags.push('close-out');
  if (i.linkedWith) tags.push(`counted once with item ${i.linkedWith.join(', ')}`);
  if (i.check === 'unchecked') tags.push('no stated figure to check');
  const suffix = tags.length ? `  [${tags.join('; ')}]` : '';
  return `  #${String(i.number).padEnd(4)}${money(i.amount).padStart(17)}  ${shortTitle(i.title)}${suffix}`;
}

function printBucket(label, bucket) {
  if (!bucket.count) return;
  console.log(`\n${label}: ${money(bucket.total)} across ${bucket.count} item${bucket.count === 1 ? '' : 's'}`);
  bucket.items.sort((a, b) => b.amount - a.amount).forEach((i) => console.log(itemLine(i)));
}

const items = (numbers) => `${numbers.length === 1 ? 'item' : 'items'} ${numbers.join(', ')}`;

function printTotal(spending) {
  if (!spending.flagged.length) {
    if (spending.count) console.log(`\nTOTAL SPENDING: ${money(spending.total)}`);
    return;
  }
  console.log(`\nTOTAL SPENDING: no exact figure, flagged ${items(spending.flagged)} still open`);
  console.log(`  at least ${money(spending.atLeast)} however they settle; ${money(spending.total)} from the items that reconcile`);
}

function report(s, others) {
  console.log(`${s.date} ${s.meetingName || s.meetingType || ''} (meeting ${s.meetingId})`);
  console.log(`${s.itemCount} items, ${s.voteCount} requiring a vote`);
  if (others.length) {
    console.log(`Also on this date: ${others.map((o) => `${o.meetingName || o.meetingType} (meeting ${o.meetingId}, ${o.agendaItems.length} items)`).join('; ')}`);
  }

  if (!s.hasProjectedCosts) {
    console.log('\nThis scrape has no PROJECTED COSTS data, so no dollar figures can be computed for it.');
  }
  printTotal(s.spending);
  if (s.range.smallest) {
    console.log('\nRANGE (spending plus grants and donations accepted)');
    console.log(`  smallest  #${s.range.smallest.number} ${money(s.range.smallest.amount)}  ${shortTitle(s.range.smallest.title)}`);
    console.log(`  largest   #${s.range.largest.number} ${money(s.range.largest.amount)}  ${shortTitle(s.range.largest.title)}`);
  }
  if (s.range.unsettled.length) {
    console.log(`  NOT SETTLED: flagged ${items(s.range.unsettled)} could fall past these ends`);
  }
  if (s.review.length) {
    console.log('\nFLAGGED (figures that do not reconcile; no figure used, not in any total or the range)');
    for (const r of s.review) {
      console.log(`  #${r.number} ${r.fileNumber || ''}: ${r.notes.join('; ')}`);
      console.log(`      ${shortTitle(r.title, 120)}`);
    }
  } else if (s.hasProjectedCosts) {
    console.log('\nFLAGGED: nothing');
  }
  printBucket('SPENDING', s.spending);
  printBucket('REALLOCATIONS (budget amendments that also move money out of a line)', s.reallocation);
  printBucket('REVENUE (money in, nothing spent on it)', s.revenue);
  printBucket('DEBT (reimbursement resolutions and bonds; not in the total)', s.debt);
  printBucket('ANNUAL BUDGET (not in the total)', s.annualBudget);

  if (s.linked.length) {
    console.log('\nCOUNTED ONCE (linked parts carrying the same dollars)');
    for (const l of s.linked) {
      console.log(`  items ${l.items.join(', ')}: ${money(l.amount)} (${l.kind})`);
    }
  }
  if (s.mentioned.length) {
    console.log('\nNAMED IN A TITLE, NOTHING ON THE SHEET (donations in kind, hearings being set; not counted)');
    s.mentioned.forEach((i) => console.log(`  #${String(i.number).padEnd(4)}${money(i.mentioned).padStart(17)}  ${shortTitle(i.title)}`));
  }
  if (s.amountTbd.length) {
    console.log(`\nAMOUNT TO BE DETERMINED, not in any total: items ${s.amountTbd.join(', ')}`);
  }
  console.log('\nNOT COUNTED AS VOTES');
  s.noVoteItems.forEach((i) => console.log(`  #${String(i.number).padEnd(4)}${shortTitle(i.title, 100)}`));
}

function main() {
  const date = arg('date');
  const meetingId = arg('meeting');
  if (!date) {
    console.error('Usage: node agenda-stats.js --date YYYY-MM-DD [--meeting ID] [--json]');
    process.exit(1);
  }
  const meetings = fs
    .readdirSync(DATA_DIR)
    .filter((f) => new RegExp(`^meeting_\\d+_${date}\\.json$`).test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')))
    .sort((a, b) => (b.agendaItems || []).length - (a.agendaItems || []).length);
  if (!meetings.length) {
    console.error(`No scraped meeting on ${date} in ${DATA_DIR}`);
    process.exit(1);
  }
  const chosen = meetingId ? meetings.find((m) => String(m.meetingId) === meetingId) : meetings[0];
  if (!chosen) {
    console.error(`No meeting ${meetingId} on ${date}; found ${meetings.map((m) => m.meetingId).join(', ')}`);
    process.exit(1);
  }
  const stats = computeAgendaStats(chosen);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  report(stats, meetings.filter((m) => m !== chosen));
}

main();

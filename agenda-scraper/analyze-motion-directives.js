#!/usr/bin/env node
/**
 * Analyze agenda items where council directed staff to appear, present,
 * or provide written/verbal reports. Count and sort by motion maker.
 *
 * Covers roughly the last 6 months of available data.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CUTOFF_DATE = '2025-09-01'; // start of 6-month window

// Phrases indicating a council-directed staff obligation (case-insensitive)
const DIRECTIVE_PATTERNS = [
  /\bwritten report\b/i,
  /\bverbal report\b/i,
  /\bin-person (?:staff )?report\b/i,
  /\bstaff to (?:appear|present|report|provide|study|prepare|come before|update)\b/i,
  /\bstaff will (?:present|appear|report|provide|be present)\b/i,
  /\bstaff to be present\b/i,
  /\bpresent a (?:written|verbal|monthly|quarterly|annual|status)? ?report\b/i,
  /\bprovide (?:a |an )?(?:written|verbal|monthly|quarterly|annual|status|in-person|updated)? ?report\b/i,
  /\bprovide (?:a |an )?update\b/i,
  /\bto update (?:city )?council\b/i,
  /\b(?:monthly|quarterly|annual) (?:in-person )?(?:update|report|appearance)\b/i,
  /\b10-minute (?:update|presentation)\b/i,
  /\bto appear before\b/i,
  /\bappearance to be held\b/i,
  /placed under staff reports.*motion made by council/i,
];

// Extract the primary motion maker (first surname before the hyphen)
function extractMotionMaker(rawTitle) {
  // Patterns like: "(Original motion initiated by Carlson-Viera on ...)"
  //                "(Motion initiated by Hurtak-Miranda on ...)"
  //                "(Original motion created by Henderson-Miranda on ...)"
  const match = rawTitle.match(
    /\((?:original )?motion(?:\s+to\s+\w+(?:\s+said\s+ordinance)?)?(?:\s+\w+)?\s+(?:initiated|created)\s+by\s+(?:motion\s+)?([A-Za-z]+)(?:-[A-Za-z]+)?/i
  );
  if (match) return match[1].trim();

  // Items placed under Staff Reports "pursuant to a motion made by Council" — no named maker
  if (/placed under staff reports.*motion made by council/i.test(rawTitle)) {
    return 'Council (unattributed)';
  }

  return null;
}

function matchesDirective(text) {
  return DIRECTIVE_PATTERNS.some((re) => re.test(text));
}

function parseDate(dateStr) {
  // meetingDate field may be "August 28, 2025" or formattedDate "2025-08-28"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = fs
  .readdirSync(DATA_DIR)
  .filter((f) => f.match(/^meeting_\d+_\d{4}-\d{2}-\d{2}\.json$/) && !f.endsWith('_old.json'));

const results = []; // { maker, fileNumber, date, meetingType, snippet }
const skippedDates = [];

for (const file of files) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
  let meeting;
  try {
    meeting = JSON.parse(raw);
  } catch {
    continue;
  }

  const dateStr = meeting.formattedDate || parseDate(meeting.meetingDate);
  if (!dateStr || dateStr < CUTOFF_DATE) {
    skippedDates.push(dateStr || file);
    continue;
  }

  const meetingType = meeting.meetingType || '';
  const items = meeting.agendaItems || [];

  for (const item of items) {
    const text = item.rawTitle || item.title || '';
    if (!matchesDirective(text)) continue;

    const maker = extractMotionMaker(text);
    if (!maker || maker === 'Council (unattributed)') continue;

    results.push({
      maker,
      fileNumber: item.fileNumber || '',
      date: dateStr,
      meetingType,
      fullText: text.trim(),
    });
  }
}

// ── Aggregate by maker ────────────────────────────────────────────────────────

const RECURRING_PATTERN = /\b(monthly|quarterly|annual|next (?:quarterly|monthly|annual)|10-minute update)\b/i;
const CRA_PATTERN = /\bCRA\s+(?:staff|to)\b/i;

const byMaker = {};
for (const r of results) {
  if (!byMaker[r.maker]) byMaker[r.maker] = { count: 0, items: [] };
  byMaker[r.maker].count++;
  byMaker[r.maker].items.push(r);
}

// Tag each item: isCRA, isRecurring (same fileNumber seen >1 time for this maker + has recurring language)
for (const [, data] of Object.entries(byMaker)) {
  const fileNumCounts = {};
  for (const item of data.items) {
    fileNumCounts[item.fileNumber] = (fileNumCounts[item.fileNumber] || 0) + 1;
  }
  for (const item of data.items) {
    item.isCRA = CRA_PATTERN.test(item.fullText) || item.fileNumber.startsWith('CRA');
    item.isRecurring =
      !item.isCRA &&
      RECURRING_PATTERN.test(item.fullText) &&
      fileNumCounts[item.fileNumber] > 1;
  }
}

// Adjusted count: CRA items removed; recurring file numbers counted once
function adjustedCount(items) {
  const seenRecurring = new Set();
  let count = 0;
  for (const item of items) {
    if (item.isCRA) continue;
    if (item.isRecurring) {
      if (seenRecurring.has(item.fileNumber)) continue;
      seenRecurring.add(item.fileNumber);
    }
    count++;
  }
  return count;
}

const sorted = Object.entries(byMaker).sort((a, b) => b[1].count - a[1].count);

// ── Output ────────────────────────────────────────────────────────────────────

const OUT_FILE = path.join(__dirname, 'output', 'motion-directives-report.md');
const lines = [];

lines.push('# Staff Directive Motion Analysis');
lines.push('');
lines.push(`**Period:** Sept 2025 – present &nbsp;|&nbsp; **Files scanned:** ${files.length - skippedDates.length} &nbsp;|&nbsp; **Raw items:** ${results.length}`);
lines.push('');
lines.push('> **Adjusted count** collapses recurring scheduled items (same file number appearing multiple times) to 1, and excludes CRA Staff items.');
lines.push('');

// Summary table
lines.push('## Summary');
lines.push('');
lines.push('| Motion Maker | Raw Count | Adjusted Count |');
lines.push('|---|---|---|');
for (const [maker, data] of sorted) {
  const adj = adjustedCount(data.items);
  lines.push(`| ${maker} | ${data.count} | ${adj} |`);
}
lines.push('');

// Per-maker detail tables
lines.push('---');
lines.push('');
for (const [maker, data] of sorted) {
  data.items.sort((a, b) => a.date.localeCompare(b.date));
  const adj = adjustedCount(data.items);

  const oneTime   = data.items.filter(i => !i.isCRA && !i.isRecurring);
  const recurring = data.items.filter(i => i.isRecurring);
  const cra       = data.items.filter(i => i.isCRA);

  // Collapse recurring: keep only first occurrence per fileNumber, annotate count
  const seenRec = new Set();
  const recurringDeduped = recurring.filter(i => {
    if (seenRec.has(i.fileNumber)) return false;
    seenRec.add(i.fileNumber);
    i.appearances = recurring.filter(r => r.fileNumber === i.fileNumber).length;
    return true;
  });

  lines.push(`## ${maker}`);
  lines.push('');
  lines.push(`**Raw:** ${data.count} &nbsp;|&nbsp; **Adjusted:** ${adj}`);
  lines.push('');

  function tableRows(items, showAppearances = false) {
    if (showAppearances) {
      lines.push('| Date | File No. | Appearances | Motion |');
      lines.push('|---|---|---|---|');
    } else {
      lines.push('| Date | File No. | Motion |');
      lines.push('|---|---|---|');
    }
    for (const item of items) {
      const escaped = item.fullText.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
      if (showAppearances) {
        lines.push(`| ${item.date} | ${item.fileNumber} | ${item.appearances} | ${escaped} |`);
      } else {
        lines.push(`| ${item.date} | ${item.fileNumber} | ${escaped} |`);
      }
    }
    lines.push('');
  }

  if (oneTime.length) {
    lines.push(`### One-time directives (${oneTime.length})`);
    lines.push('');
    tableRows(oneTime);
  }

  if (recurringDeduped.length) {
    lines.push(`### Recurring scheduled items — counted as 1 each (${recurringDeduped.length} unique)`);
    lines.push('');
    tableRows(recurringDeduped, true);
  }

  if (cra.length) {
    lines.push(`### CRA Staff items — excluded from adjusted count (${cra.length})`);
    lines.push('');
    tableRows(cra);
  }
}

fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf-8');
console.log(`Written: ${OUT_FILE}`);

// ── WordPress Block HTML output ───────────────────────────────────────────────

const WP_FILE = path.join(__dirname, 'output', 'motion-directives-report.wp.html');
const wp = [];

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wpTable(items, showAppearances = false) {
  const cols = showAppearances
    ? ['Date', 'File No.', 'Appearances', 'Motion']
    : ['Date', 'File No.', 'Motion'];

  wp.push('<!-- wp:table -->');
  wp.push('<figure class="wp-block-table"><table><thead><tr>');
  for (const col of cols) wp.push(`<th>${col}</th>`);
  wp.push('</tr></thead><tbody>');
  for (const item of items) {
    const text = esc(item.fullText.replace(/\n+/g, ' '));
    wp.push('<tr>');
    wp.push(`<td>${item.date}</td>`);
    wp.push(`<td>${esc(item.fileNumber)}</td>`);
    if (showAppearances) wp.push(`<td>${item.appearances}</td>`);
    wp.push(`<td>${text}</td>`);
    wp.push('</tr>');
  }
  wp.push('</tbody></table></figure>');
  wp.push('<!-- /wp:table -->');
  wp.push('');
}

wp.push('<!-- wp:heading -->');
wp.push('<h2 class="wp-block-heading">Staff Directive Motion Analysis</h2>');
wp.push('<!-- /wp:heading -->');
wp.push('');
wp.push('<!-- wp:paragraph -->');
wp.push(`<p><strong>Period:</strong> Sept 2025 – present | <strong>Files scanned:</strong> ${files.length - skippedDates.length} | <strong>Raw items:</strong> ${results.length}</p>`);
wp.push('<!-- /wp:paragraph -->');
wp.push('');
wp.push('<!-- wp:quote -->');
wp.push('<blockquote class="wp-block-quote"><p><strong>Adjusted count</strong> collapses recurring scheduled items (same file number appearing multiple times) to 1, and excludes CRA Staff items.</p></blockquote>');
wp.push('<!-- /wp:quote -->');
wp.push('');

// Summary table
wp.push('<!-- wp:heading {"level":3} -->');
wp.push('<h3 class="wp-block-heading">Summary</h3>');
wp.push('<!-- /wp:heading -->');
wp.push('');
wp.push('<!-- wp:table -->');
wp.push('<figure class="wp-block-table"><table><thead><tr><th>Motion Maker</th><th>Raw Count</th><th>Adjusted Count</th></tr></thead><tbody>');
for (const [maker, data] of sorted) {
  const adj = adjustedCount(data.items);
  wp.push(`<tr><td>${esc(maker)}</td><td>${data.count}</td><td>${adj}</td></tr>`);
}
wp.push('</tbody></table></figure>');
wp.push('<!-- /wp:table -->');
wp.push('');
wp.push('<!-- wp:separator -->');
wp.push('<hr class="wp-block-separator has-alpha-channel-opacity"/>');
wp.push('<!-- /wp:separator -->');
wp.push('');

// Per-maker sections
for (const [maker, data] of sorted) {
  data.items.sort((a, b) => a.date.localeCompare(b.date));
  const adj = adjustedCount(data.items);

  const oneTime   = data.items.filter(i => !i.isCRA && !i.isRecurring);
  const recurring = data.items.filter(i => i.isRecurring);
  const cra       = data.items.filter(i => i.isCRA);

  const seenRec = new Set();
  const recurringDeduped = recurring.filter(i => {
    if (seenRec.has(i.fileNumber)) return false;
    seenRec.add(i.fileNumber);
    i.appearances = recurring.filter(r => r.fileNumber === i.fileNumber).length;
    return true;
  });

  wp.push('<!-- wp:heading {"level":3} -->');
  wp.push(`<h3 class="wp-block-heading">${esc(maker)}</h3>`);
  wp.push('<!-- /wp:heading -->');
  wp.push('');
  wp.push('<!-- wp:paragraph -->');
  wp.push(`<p><strong>Raw:</strong> ${data.count} | <strong>Adjusted:</strong> ${adj}</p>`);
  wp.push('<!-- /wp:paragraph -->');
  wp.push('');

  if (oneTime.length) {
    wp.push('<!-- wp:heading {"level":4} -->');
    wp.push(`<h4 class="wp-block-heading">One-time directives (${oneTime.length})</h4>`);
    wp.push('<!-- /wp:heading -->');
    wp.push('');
    wpTable(oneTime);
  }

  if (recurringDeduped.length) {
    wp.push('<!-- wp:heading {"level":4} -->');
    wp.push(`<h4 class="wp-block-heading">Recurring scheduled items — counted as 1 each (${recurringDeduped.length} unique)</h4>`);
    wp.push('<!-- /wp:heading -->');
    wp.push('');
    wpTable(recurringDeduped, true);
  }

  if (cra.length) {
    wp.push('<!-- wp:heading {"level":4} -->');
    wp.push(`<h4 class="wp-block-heading">CRA Staff items — excluded from adjusted count (${cra.length})</h4>`);
    wp.push('<!-- /wp:heading -->');
    wp.push('');
    wpTable(cra);
  }
}

fs.writeFileSync(WP_FILE, wp.join('\n'), 'utf-8');
console.log(`Written: ${WP_FILE}`);

#!/usr/bin/env node
/**
 * Withdraw one mirrored document from the archive.
 *
 * Usage:
 *   node withdraw-document.js <mirrored-url | r2-key> --reason <code> [--dry-run]
 *
 * Reasons: privacy-request | city-request | legal | error
 *
 * What it does, in order:
 *   1. Resolves the key to exactly one document in one meeting JSON.
 *   2. Adds the entry to data/withdrawn-documents.json (what, never who).
 *   3. Deletes the R2 object (S3_* env from .env) and confirms it is gone.
 *   4. Stamps the meeting JSON: `withdrawn: {on, reason}`, mirroredUrl removed.
 *   5. Prints the regenerate / rebuild / deploy / commit commands. It does not
 *      run them.
 *
 * Reversal: delete the entry from the list and re-run
 * `node mirror-documents.js <meetingId>`; the mirror re-uploads because the
 * object is gone. There is no separate restore command.
 *
 * Why this exists: docs/plans/WITHDRAWN-DOCUMENTS-PLAN.md, and the header of
 * lib/withdrawn-documents.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { DocumentMirror } = require('./lib/document-mirror');
const {
  REASONS,
  loadWithdrawn,
  saveWithdrawn,
  keyFromUrl,
  findDocument,
  applyWithdrawals,
} = require('./lib/withdrawn-documents');

const DATA_DIR = path.join(__dirname, 'data');

function parseArgs(argv) {
  const options = { target: null, reason: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--reason' || arg === '-r') options.reason = argv[++i];
    else if (arg.startsWith('--reason=')) options.reason = arg.slice('--reason='.length);
    else if (!options.target) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

function showHelp() {
  console.log(`
Withdraw a mirrored document from the archive

Usage:
  node withdraw-document.js <mirrored-url | r2-key> --reason <code> [--dry-run]

Reasons:
  ${REASONS.join(' | ')}

Options:
  -r, --reason <code>   Why (required; closed vocabulary above)
  -n, --dry-run         Resolve and report, change nothing
  -h, --help            This message

The list (data/withdrawn-documents.json) is public with the repo. It records
what was withdrawn and why in one word, never who asked.
`);
}

/** The meeting JSON that owns a key: data/meeting_<id>_<date>.json */
function meetingFileForKey(key) {
  const m = key.match(/^(\d{4}-\d{2}-\d{2})\/meeting-(\d+)\//);
  if (!m) throw new Error(`Not an R2 key: ${key}`);
  const [, date, meetingId] = m;
  const candidates = fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(`meeting_${meetingId}_`) && f.endsWith('.json'));
  if (candidates.length !== 1) {
    throw new Error(`Expected one data/meeting_${meetingId}_*.json, found ${candidates.length}`);
  }
  const file = path.join(DATA_DIR, candidates[0]);
  if (!candidates[0].includes(date)) {
    console.warn(`Note: key date ${date} differs from file ${candidates[0]}; matching by recomputed key anyway`);
  }
  return file;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.target) {
    showHelp();
    process.exit(options.help ? 0 : 1);
  }
  if (!REASONS.includes(options.reason)) {
    console.error(`--reason must be one of: ${REASONS.join(', ')}`);
    process.exit(1);
  }

  const key = keyFromUrl(options.target);
  const list = loadWithdrawn();
  if (list.documents.some((d) => d.key === key)) {
    console.error(`Already withdrawn: ${key}`);
    process.exit(1);
  }

  const file = meetingFileForKey(key);
  const meetingData = JSON.parse(fs.readFileSync(file, 'utf8'));
  const found = findDocument(meetingData, key);
  if (!found) {
    console.error(`No document in ${path.basename(file)} mirrors to ${key}`);
    console.error('Check the key against the item\'s supportingDocuments titles; the key is derived from the title.');
    process.exit(1);
  }
  const { item, doc } = found;

  const entry = {
    key,
    meetingId: Number(meetingData.meetingId),
    agendaItemId: Number(item.agendaItemId),
    fileNumber: item.fileNumber || '',
    title: doc.title || doc.originalText || 'Document',
    withdrawnOn: new Date().toISOString().slice(0, 10),
    reason: options.reason,
  };

  console.log('Document to withdraw');
  console.log(`  meeting:  ${meetingData.meetingId} (${meetingData.formattedDate || meetingData.meetingDate})${meetingData.meetingName ? ' — ' + meetingData.meetingName : ''}`);
  console.log(`  item:     ${item.number} [${item.fileNumber || '-'}] ${String(item.title || '').split('\n')[0].slice(0, 120)}`);
  console.log(`  title:    ${entry.title}`);
  console.log(`  key:      ${key}`);
  console.log(`  mirrored: ${doc.mirroredUrl || '(no mirroredUrl stamp on disk)'}`);
  console.log(`  city:     ${doc.url}`);
  console.log(`  reason:   ${options.reason}`);

  if (options.dryRun) {
    console.log('\n[DRY RUN] Nothing changed.');
    return;
  }

  // 2. The list first: if anything below fails, the next mirror run still
  //    refuses to re-upload, and re-running this command is safe.
  list.documents.push(entry);
  saveWithdrawn(list);
  console.log('\n✓ Added to data/withdrawn-documents.json');

  // 3. R2
  const mirror = new DocumentMirror();
  const { existed } = await mirror.deleteDocument(key);
  if (await mirror.exists(key)) {
    throw new Error(`R2 still reports ${key} after delete — stop and check the bucket`);
  }
  console.log(existed ? `✓ Deleted from R2: ${key}` : `○ R2 had no object at ${key} (nothing to delete)`);
  if (existed) {
    console.log(`
⚠️  Cloudflare's edge keeps a cached copy of GETs on the custom domain for up to
   a year (cf-cache-status: HIT, with the object gone from R2). Purge it by URL
   in the dashboard: Caching → Configuration → Purge Cache → Custom purge → URL:
     ${mirror.getPublicUrl(key)}
   Confirm with: curl -sI "${mirror.getPublicUrl(key)}" | grep -i "^HTTP\\|cf-cache-status"  (expect 404)`);
  }

  // 4. Stamp the JSON
  applyWithdrawals(meetingData, list);
  fs.writeFileSync(file, JSON.stringify(meetingData, null, 2));
  console.log(`✓ Stamped ${path.basename(file)}`);

  // 5. What is left, for Michael
  const date = meetingData.formattedDate || '<YYYY-MM-DD>';
  console.log(`
Next, from the repo root:
  (cd agenda-scraper && node json-to-markdown.js --date ${date})   # tm-static post now links the City's copy
  npm run build-db && npm run build-site && npm run deploy          # meetings site
  git add agenda-scraper/data && git commit -m "withdraw ${path.basename(key)} (${options.reason})" && git push
  cd ~/tampa-monitor/tm-static && git add src/posts && git commit -m "agenda ${date}: withdrawn document" && git push

The City's copy stays at the OnBase URL above; that is what to send the requester.
`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

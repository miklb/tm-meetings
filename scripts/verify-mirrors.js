#!/usr/bin/env node
/**
 * Verify that every mirroredUrl in agenda-scraper/data/*.json serves a real
 * document from the public R2 domain — the check that would have caught the
 * 2026-03-19 incident (OnBase error pages archived as .pdf, serving HTTP 200
 * with content-type application/pdf).
 *
 * Uses GET (not HEAD): HEAD bypasses Cloudflare's edge cache and can report a
 * fresh object while every browser GET still serves a stale one. Only the
 * first 1KB of each document is fetched (Range request).
 *
 * Usage:
 *   node scripts/verify-mirrors.js              # verify everything
 *   node scripts/verify-mirrors.js 2611         # verify one meeting id
 *   node scripts/verify-mirrors.js 2025-09-04   # verify one date
 *
 * Exit code 1 if any document fails.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'agenda-scraper', 'data');
const CONCURRENCY = 8;

function collectUrls(filter) {
  const rows = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.startsWith('meeting_') || !f.endsWith('.json')) continue;
    if (filter && !f.includes(filter)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const item of data.agendaItems || []) {
      for (const doc of item.supportingDocuments || []) {
        if (doc.mirroredUrl) {
          rows.push({ file: f, item: item.number, url: doc.mirroredUrl });
        }
      }
    }
  }
  return rows;
}

async function checkOne(row) {
  let res, body;
  try {
    res = await fetch(row.url, {
      headers: { Range: 'bytes=0-1023' },
      signal: AbortSignal.timeout(20000),
    });
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ...row, problem: `fetch failed: ${err.message}` };
  }

  if (res.status !== 200 && res.status !== 206) {
    return { ...row, problem: `HTTP ${res.status}` };
  }

  const preview = body.toString('ascii').trim().toLowerCase();
  if (preview.startsWith('<!doctype html') || preview.startsWith('<html')) {
    return { ...row, problem: 'serves an HTML page, not a document' };
  }
  if (row.url.toLowerCase().endsWith('.pdf') && !body.includes('%PDF-')) {
    return { ...row, problem: 'no %PDF header in first 1KB' };
  }
  return null;
}

async function main() {
  const filter = process.argv[2] || null;
  const rows = collectUrls(filter);
  console.log(`Verifying ${rows.length} mirrored document(s)${filter ? ` matching "${filter}"` : ''}...`);

  const failures = [];
  let done = 0;
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        const fail = await checkOne(row);
        if (fail) failures.push(fail);
        done++;
        if (done % 500 === 0) console.log(`  ...${done}/${rows.length}`);
      }
    })
  );

  if (failures.length === 0) {
    console.log(`✓ All ${rows.length} documents verified.`);
    return;
  }

  console.log(`\n✗ ${failures.length} document(s) failed:\n`);
  const byFile = {};
  for (const f of failures) (byFile[f.file] ||= []).push(f);
  for (const [file, fails] of Object.entries(byFile)) {
    console.log(`${file} — ${fails.length} bad:`);
    for (const f of fails.slice(0, 5)) {
      console.log(`  item ${f.item}: ${f.problem}\n    ${f.url}`);
    }
    if (fails.length > 5) console.log(`  ...and ${fails.length - 5} more`);
  }
  console.log('\nRepair: node json-scraper.js <id> --type <type> && node mirror-documents.js <id> --force');
  console.log('(then purge the Cloudflare cache — see the --force warning in mirror-documents.js)');
  process.exitCode = 1;
}

main();

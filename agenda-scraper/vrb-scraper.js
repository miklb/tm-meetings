#!/usr/bin/env node
/**
 * Variance Review Board collector.
 *
 * Reads the two VRB listings on tampa.gov (agendas, minutes), follows each
 * document page to its PDF, extracts the text and parses the agenda's case
 * blocks. Output, all under data/vrb/:
 *
 *   vrb_<hearing date>.json   one file per hearing: every document posted for
 *                             it, plus the cases from the latest agenda
 *   text/<document slug>.txt  extracted PDF text, as the parser saw it
 *
 * Nothing here feeds build-db or the agenda posts; this only collects. Files
 * are rewritten only when something changed, so a quiet night is a no-op.
 *
 * Usage:
 *   node vrb-scraper.js             collect new and recently changed documents
 *   node vrb-scraper.js --all       re-check every listed document page
 *   node vrb-scraper.js --mirror    also copy PDFs to R2 (needs the S3_* env)
 *   node vrb-scraper.js --reparse   re-run the parser over stored text, offline
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { parseVrbAgenda, resolveHearingDate } = require('./lib/vrb-parser');
const { extractTextFromBuffer } = require('./lib/pdf-text-extractor');
const { SITE, parseListing, isPaginated, parseDocumentPage, fetchHtml, fetchPdf } = require('./lib/tampa-gov-documents');

const LISTINGS = [
  { kind: 'agenda', url: `${SITE}/development-coordination/vrb-agendas` },
  { kind: 'minutes', url: `${SITE}/development-coordination/vrb-minutes` },
];

const DATA_DIR = path.join(__dirname, 'data', 'vrb');
const TEXT_DIR = path.join(DATA_DIR, 'text');

// Document pages for hearings older than this are not re-checked nightly;
// staff revise an agenda up to the hearing, not after it. --all overrides.
const SETTLED_AFTER_DAYS = 14;
const REQUEST_GAP_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const today = () => new Date().toISOString().slice(0, 10);
const textPath = (slug) => path.join(TEXT_DIR, `${slug}.txt`);

function loadHearings() {
  const hearings = new Map();
  if (!fs.existsSync(DATA_DIR)) return hearings;
  for (const file of fs.readdirSync(DATA_DIR).filter((f) => /^vrb_\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const hearing = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    hearings.set(hearing.hearingDate, hearing);
  }
  return hearings;
}

function findDocument(hearings, slug) {
  for (const hearing of hearings.values()) {
    const doc = hearing.documents.find((d) => d.slug === slug);
    if (doc) return { hearing, doc };
  }
  return null;
}

/**
 * The latest posted agenda is canonical; earlier ones stay in `documents` as
 * history. Cases are always re-derived from the canonical agenda's stored text.
 */
function rebuildHearing(hearing) {
  // Order by Drupal node id, i.e. by when staff created the document page.
  // "Date Posted" is typed by hand and cannot be trusted for this: both
  // January 2026 agendas carry 2026-03-10, and the March agenda is dated
  // three days after its hearing.
  hearing.documents.sort((a, b) =>
    (a.nodeId || 0) - (b.nodeId || 0) || (a.postedDate || '').localeCompare(b.postedDate || ''));

  const canonical = hearing.documents.filter((d) => d.kind === 'agenda').pop();
  hearing.canonicalAgenda = canonical ? canonical.slug : null;

  if (canonical && !fs.existsSync(textPath(canonical.slug))) {
    // Keep the stored cases rather than lose the night's other hearings to a throw.
    hearing.warnings = [`Stored text for ${canonical.slug} is missing; cases not re-derived`];
    return hearing;
  }

  hearing.cases = [];
  hearing.warnings = [];

  if (canonical) {
    const parsed = parseVrbAgenda(fs.readFileSync(textPath(canonical.slug), 'utf8'));
    hearing.hearingTime = parsed.hearingTime;
    hearing.location = parsed.location;
    hearing.cases = parsed.cases;
    hearing.warnings = parsed.warnings;
    if (!parsed.cases.length) hearing.warnings.push('Agenda has no cases (cancellation notice?)');
  }
  return hearing;
}

function saveHearings(hearings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let written = 0;
  for (const hearing of hearings.values()) {
    const file = path.join(DATA_DIR, `vrb_${hearing.hearingDate}.json`);
    if (!hearing.documents.length) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      continue;
    }
    const json = `${JSON.stringify(rebuildHearing(hearing), null, 2)}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === json) continue;
    fs.writeFileSync(file, json);
    written++;
    console.log(`[VRB] wrote ${path.relative(__dirname, file)} (${hearing.cases.length} cases, ${hearing.documents.length} documents)`);
    const warnings = [...hearing.warnings, ...hearing.documents.flatMap((d) => d.warnings || [])];
    for (const warning of warnings) console.warn(`[VRB]   ⚠️  ${warning}`);
  }
  return written;
}

/**
 * --reparse: re-derive every document's hearing date from its stored text, so
 * a parser fix reaches what is already collected without touching tampa.gov.
 * Hearings left with no documents are dropped by saveHearings.
 */
function regroup(hearings) {
  const documents = [...hearings.values()].flatMap((hearing) => hearing.documents.splice(0));
  for (const doc of documents) {
    const resolved = resolveHearingDate(fs.readFileSync(textPath(doc.slug), 'utf8'), doc.title);
    doc.warnings = resolved.warnings;
    if (!hearings.has(resolved.hearingDate)) hearings.set(resolved.hearingDate, newHearing(resolved.hearingDate));
    hearings.get(resolved.hearingDate).documents.push(doc);
  }
  return hearings;
}

function newHearing(hearingDate) {
  return {
    board: 'vrb',
    boardName: 'Variance Review Board',
    hearingDate,
    hearingTime: null,
    location: null,
    canonicalAgenda: null,
    documents: [],
    cases: [],
    warnings: [],
  };
}

async function mirrorPdf(mirror, hearingDate, pdfUrl, sha256, buffer) {
  // The hash in the key keeps a revised PDF from overwriting the one it
  // replaced: mirrored objects are served with a one-year cache.
  const filename = mirror.sanitizeFilename(decodeURIComponent(new URL(pdfUrl).pathname.split('/').pop()));
  const key = `boards/vrb/${hearingDate}/${sha256.slice(0, 8)}-${filename}`;
  if (!(await mirror.exists(key))) await mirror.uploadDocument(key, buffer, 'application/pdf');
  return mirror.getPublicUrl(key);
}

/**
 * Collect one listed document. Returns 'skipped' | 'unchanged' | 'new' | 'revised'.
 */
async function collectDocument(listed, kind, hearings, options) {
  const known = findDocument(hearings, listed.slug);
  const hasText = fs.existsSync(textPath(listed.slug));
  const wantsMirror = Boolean(options.mirror) && !(known && known.doc.mirroredUrl);

  const cutoff = new Date(Date.now() - SETTLED_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
  if (known && hasText && !wantsMirror && !options.all && known.hearing.hearingDate < cutoff) return 'skipped';

  await sleep(REQUEST_GAP_MS);
  const page = parseDocumentPage(await fetchHtml(listed.documentUrl));
  if (!page.pdfUrl) throw new Error('no PDF link on the document page');

  const samePage = known && hasText && known.doc.pdfUrl === page.pdfUrl && known.doc.updatedTime === page.updatedTime;
  if (samePage && !wantsMirror) return 'unchanged';

  await sleep(REQUEST_GAP_MS);
  const buffer = await fetchPdf(page.pdfUrl);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const sameBytes = known && hasText && known.doc.pdfSha256 === sha256;

  let doc;
  let hearingDate;
  if (sameBytes) {
    doc = known.doc;
    hearingDate = known.hearing.hearingDate;
    Object.assign(doc, { pdfUrl: page.pdfUrl, updatedTime: page.updatedTime });
  } else {
    const { text, pages } = await extractTextFromBuffer(buffer);
    const title = page.title || listed.title;
    const resolved = resolveHearingDate(text, title);
    ({ hearingDate } = resolved);
    if (!hearingDate) throw new Error('no hearing date in the PDF header or title; nothing stored');

    fs.mkdirSync(TEXT_DIR, { recursive: true });
    fs.writeFileSync(textPath(listed.slug), text);

    const previousVersions = known ? [...(known.doc.previousVersions || [])] : [];
    if (known) {
      const { pdfUrl, pdfSha256, updatedTime, mirroredUrl } = known.doc;
      previousVersions.push({ pdfUrl, pdfSha256, updatedTime, mirroredUrl: mirroredUrl || null, replacedOn: today() });
      // A revision can move the hearing (June 2026 went from the 9th to the 16th).
      known.hearing.documents = known.hearing.documents.filter((d) => d.slug !== listed.slug);
    }

    doc = {
      kind,
      slug: listed.slug,
      nodeId: listed.nodeId,
      title,
      documentUrl: listed.documentUrl,
      postedDate: page.postedDate || listed.postedDate,
      updatedTime: page.updatedTime,
      pdfUrl: page.pdfUrl,
      pdfSha256: sha256,
      pdfBytes: buffer.length,
      pages,
      textFile: `text/${listed.slug}.txt`,
      firstSeen: known ? known.doc.firstSeen : today(),
      mirroredUrl: null,
      warnings: resolved.warnings,
      previousVersions,
    };
    if (!hearings.has(hearingDate)) hearings.set(hearingDate, newHearing(hearingDate));
    hearings.get(hearingDate).documents.push(doc);
  }

  if (options.mirror && !doc.mirroredUrl) {
    doc.mirroredUrl = await mirrorPdf(options.mirror, hearingDate, page.pdfUrl, sha256, buffer);
  }

  if (sameBytes) return 'unchanged';
  return known ? 'revised' : 'new';
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const hearings = loadHearings();

  if (args.has('--reparse')) {
    const regrouped = regroup(hearings);
    console.log(`[VRB] re-parsed ${regrouped.size} hearings, ${saveHearings(regrouped)} changed`);
    return 0;
  }

  const options = { all: args.has('--all'), mirror: null };
  if (args.has('--mirror')) {
    const { DocumentMirror } = require('./lib/document-mirror');
    options.mirror = new DocumentMirror();
  }

  const counts = { skipped: 0, unchanged: 0, new: 0, revised: 0, failed: 0 };
  for (const listing of LISTINGS) {
    const html = await fetchHtml(listing.url);
    const listed = parseListing(html);
    // A listing that comes back empty is a changed page, not an empty archive.
    if (!listed.length) throw new Error(`No VRB ${listing.kind} documents found at ${listing.url}`);
    console.log(`[VRB] ${listing.kind} listing: ${listed.length} documents`);
    if (isPaginated(html)) {
      counts.failed++;
      console.error(`[VRB] ❌ ${listing.kind} listing is now paginated; only its first page was read (${listing.url})`);
    }

    for (const item of listed) {
      try {
        const outcome = await collectDocument(item, listing.kind, hearings, options);
        counts[outcome]++;
        if (outcome === 'new' || outcome === 'revised') console.log(`[VRB] ${outcome}: ${item.title} (${item.slug})`);
      } catch (err) {
        counts.failed++;
        console.error(`[VRB] ❌ ${item.slug}: ${err.message}`);
      }
    }
  }

  saveHearings(hearings);
  console.log(`[VRB] done — ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  return counts.failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[VRB] ❌ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { rebuildHearing, newHearing };

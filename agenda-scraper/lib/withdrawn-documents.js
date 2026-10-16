/**
 * Withdrawn documents — the standing path for a takedown request.
 *
 * "Withdrawn" means the archive stops hosting its copy of one supporting
 * document. The agenda item, its title, its other documents and the link to
 * the City's own copy all stay; only the R2 mirror goes. The City's record is
 * not ours to change.
 *
 * Why a sidecar list and not a flag in the meeting JSON: the scrape guard
 * carries exactly one document field across re-scrapes (mirroredUrl), and the
 * mirror step re-uploads whenever the R2 object is missing, so a deleted
 * object comes straight back on the next weekly run. The list in
 * data/withdrawn-documents.json is the source of truth; applyWithdrawals()
 * re-stamps the meeting JSON from it on every pipeline run, the same way
 * mirroredUrl is re-stamped from R2 state.
 *
 * The repo is public. The list records WHAT was withdrawn, never who asked:
 * loadWithdrawn() refuses any entry with a field outside FIELDS or a reason
 * outside REASONS, and test/withdrawn-documents.test.js validates the real
 * file. Keep it that way.
 *
 * Identity is the R2 object key (also the path of the public URL): stable
 * across City republishes (no publishId in it) and recomputable from the
 * scraped JSON at any step, so it works whether or not mirroredUrl is still
 * present.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  planDocumentFilenames,
  sanitizeFilename,
  getExtFromUrl,
  formatMeetingDate,
} = require('./document-mirror');

const LIST_PATH = path.join(__dirname, '..', 'data', 'withdrawn-documents.json');

/** Closed vocabulary. Add a word here, with a sentence on why, before using it. */
const REASONS = ['privacy-request', 'city-request', 'legal', 'error'];

/** Every field an entry may have. Nothing else is accepted. */
const FIELDS = ['key', 'meetingId', 'agendaItemId', 'fileNumber', 'title', 'withdrawnOn', 'reason'];

const KEY_RE = /^\d{4}-\d{2}-\d{2}\/meeting-\d+\/\d+\/[a-z0-9._-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateEntry(entry, index) {
  const where = `withdrawn-documents.json entry ${index}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${where}: not an object`);
  }
  const extra = Object.keys(entry).filter((k) => !FIELDS.includes(k));
  if (extra.length) {
    throw new Error(`${where}: unexpected field(s) ${extra.join(', ')} — the list records what was withdrawn, never who asked`);
  }
  const missing = FIELDS.filter((k) => entry[k] === undefined || entry[k] === null || entry[k] === '');
  if (missing.length) throw new Error(`${where}: missing ${missing.join(', ')}`);
  if (typeof entry.key !== 'string' || !KEY_RE.test(entry.key)) {
    throw new Error(`${where}: key must be an R2 key like 2026-05-14/meeting-2829/23310/file.pdf, got ${JSON.stringify(entry.key)}`);
  }
  if (!REASONS.includes(entry.reason)) {
    throw new Error(`${where}: reason must be one of ${REASONS.join(', ')}, got ${JSON.stringify(entry.reason)}`);
  }
  if (!DATE_RE.test(String(entry.withdrawnOn))) throw new Error(`${where}: withdrawnOn must be YYYY-MM-DD`);
  if (!/^\d+$/.test(String(entry.meetingId)) || !/^\d+$/.test(String(entry.agendaItemId))) {
    throw new Error(`${where}: meetingId and agendaItemId must be numeric`);
  }
  if (!entry.key.includes(`/meeting-${entry.meetingId}/${entry.agendaItemId}/`)) {
    throw new Error(`${where}: key does not belong to meeting ${entry.meetingId} item ${entry.agendaItemId}`);
  }
}

/**
 * Load and validate the list. A missing file is an empty list; a malformed
 * entry throws, so a bad edit stops the pipeline instead of silently
 * re-mirroring something.
 * @param {string} [listPath]
 * @returns {{documents: Array<Object>}}
 */
function loadWithdrawn(listPath = LIST_PATH) {
  if (!fs.existsSync(listPath)) return { documents: [] };
  const parsed = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  const documents = Array.isArray(parsed.documents) ? parsed.documents : null;
  if (!documents) throw new Error('withdrawn-documents.json: expected { "documents": [...] }');
  documents.forEach(validateEntry);
  const keys = documents.map((d) => d.key);
  const dupe = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupe) throw new Error(`withdrawn-documents.json: duplicate key ${dupe}`);
  return { documents };
}

function saveWithdrawn(list, listPath = LIST_PATH) {
  list.documents.forEach(validateEntry);
  fs.writeFileSync(listPath, JSON.stringify(list, null, 2) + '\n');
}

/**
 * Turn a public mirror URL (or a bare key) into the R2 key.
 * @param {string} urlOrKey
 * @returns {string}
 */
function keyFromUrl(urlOrKey) {
  const s = String(urlOrKey || '').trim();
  const key = s.replace(/^https?:\/\/[^/]+\//, '').replace(/[?#].*$/, '');
  return decodeURIComponent(key);
}

function meetingDateOf(meetingData) {
  return meetingData.formattedDate || formatMeetingDate(meetingData.meetingDate);
}

/**
 * The R2 key each document in an item mirrors to, in page order. Pure: the
 * same planning the mirror step does, with no S3 client.
 * @returns {string[]}
 */
function itemDocumentKeys(meetingData, item) {
  const docs = item.supportingDocuments || [];
  if (!docs.length) return [];
  const date = meetingDateOf(meetingData);
  const names = planDocumentFilenames(docs, sanitizeFilename, getExtFromUrl);
  return names.map((n) => `${date}/meeting-${meetingData.meetingId}/${item.agendaItemId}/${sanitizeFilename(n)}`);
}

/**
 * Stamp `withdrawn: {on, reason}` on every listed document and drop its
 * mirroredUrl; clear a stale stamp from a document no longer on the list
 * (reversal is deleting the entry). Mutates meetingData.
 * @param {Object} meetingData
 * @param {{documents: Array<Object>}} [list]
 * @returns {{withdrawn: number, changed: number}} withdrawn = documents now
 *   stamped; changed = documents whose JSON this call altered
 */
function applyWithdrawals(meetingData, list = loadWithdrawn()) {
  const byKey = new Map(list.documents.map((d) => [d.key, d]));
  let withdrawn = 0;
  let changed = 0;
  if (!meetingData || !Array.isArray(meetingData.agendaItems)) return { withdrawn, changed };
  for (const item of meetingData.agendaItems) {
    const docs = item.supportingDocuments || [];
    if (!docs.length) continue;
    const keys = byKey.size ? itemDocumentKeys(meetingData, item) : [];
    docs.forEach((doc, i) => {
      const entry = byKey.get(keys[i]);
      if (entry) {
        withdrawn++;
        const stamp = { on: entry.withdrawnOn, reason: entry.reason };
        const same = doc.withdrawn && doc.withdrawn.on === stamp.on && doc.withdrawn.reason === stamp.reason;
        if (!same || doc.mirroredUrl) changed++;
        doc.withdrawn = stamp;
        delete doc.mirroredUrl;
      } else if (doc.withdrawn) {
        delete doc.withdrawn;
        changed++;
      }
    });
  }
  return { withdrawn, changed };
}

/**
 * Locate the document a key refers to.
 * @returns {{item: Object, doc: Object, index: number}|null}
 */
function findDocument(meetingData, key) {
  for (const item of meetingData.agendaItems || []) {
    const keys = itemDocumentKeys(meetingData, item);
    const index = keys.indexOf(key);
    if (index !== -1) return { item, doc: item.supportingDocuments[index], index };
  }
  return null;
}

module.exports = {
  LIST_PATH,
  REASONS,
  FIELDS,
  loadWithdrawn,
  saveWithdrawn,
  keyFromUrl,
  itemDocumentKeys,
  applyWithdrawals,
  findDocument,
};

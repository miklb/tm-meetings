/**
 * Structured meeting diff producer.
 *
 * Returns a data object (no markdown/strings) describing meaningful changes
 * between two versions of meeting JSON. The logic mirrors `formatSummary` in
 * diff-without-urls.js but emits structured fields instead of display strings.
 *
 * Usage:
 *   const { computeMeetingDiff } = require('./diff-meeting');
 *   const diff = computeMeetingDiff(oldMeetingData, newMeetingData);
 *   // diff = {
 *   //   agendaTypePromoted: { from: 'DRAFT', to: 'FINAL' } | null,
 *   //   itemsAdded:   [{ agendaItemId, number, fileNumber, shortTitle }],
 *   //   itemsRemoved: [{ agendaItemId, number, fileNumber, shortTitle }],
 *   //   documentsAdded: [{ itemNumber, itemFileNumber, filename, copy? }],
 *   // }
 */

'use strict';

/**
 * Extract a short human-readable title from an agenda item.
 * Uses the first 80 chars of rawTitle stripped of legal boilerplate.
 * @param {Object} item
 * @returns {string}
 */
function shortTitle(item) {
  let text = item.rawTitle || item.title || '';
  // Strip common boilerplate prefixes
  text = text
    .replace(/^(AN ORDINANCE|A RESOLUTION|MOTION|APPROVE|AUTHORIZING|CONSIDERATION OF)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > 80 ? text.slice(0, 77) + '…' : text;
}

/**
 * Build a compact item descriptor used in itemsAdded / itemsRemoved.
 * @param {Object} item
 * @returns {{ agendaItemId: string, number: string, fileNumber: string, shortTitle: string }}
 */
function itemDescriptor(item) {
  return {
    agendaItemId: String(item.agendaItemId || ''),
    number: item.number || '',
    fileNumber: item.fileNumber || '',
    shortTitle: shortTitle(item),
  };
}

/**
 * Compare two versions of a meeting JSON and return a structured diff.
 *
 * @param {Object} oldData  Previous scrape result.
 * @param {Object} newData  Current scrape result.
 * @returns {{
 *   agendaTypePromoted: {from: string, to: string}|null,
 *   itemsAdded:   Array,
 *   itemsRemoved: Array,
 * }}
 */
function computeMeetingDiff(oldData, newData) {
  const result = {
    agendaTypePromoted: null,
    itemsAdded: [],
    itemsRemoved: [],
    documentsAdded: [],
  };

  if (!oldData || !newData) return result;

  // 1. Agenda type promotion (e.g. DRAFT → FINAL)
  if (oldData.agendaType !== newData.agendaType) {
    result.agendaTypePromoted = { from: oldData.agendaType, to: newData.agendaType };
  }

  // 2. Items added / removed by stable agendaItemId
  const oldItems = oldData.agendaItems || [];
  const newItems = newData.agendaItems || [];
  const oldById = new Map(oldItems.map(i => [String(i.agendaItemId), i]));
  const newById = new Map(newItems.map(i => [String(i.agendaItemId), i]));

  for (const [id, item] of newById) {
    if (!oldById.has(id)) {
      result.itemsAdded.push(itemDescriptor(item));
    }
  }
  for (const [id, item] of oldById) {
    if (!newById.has(id)) {
      result.itemsRemoved.push(itemDescriptor(item));
    }
  }

  // 3. Supporting documents added to items present in both versions. Logged
  //    at scrape time so the nightly dates them the day they appeared on
  //    OnBase, not the day someone ran the mirror. Same {itemNumber,
  //    itemFileNumber, filename} shape the mirror step used to write.
  for (const [id, item] of newById) {
    const oldItem = oldById.get(id);
    if (!oldItem) continue; // whole item is new — covered by itemsAdded
    const { added } = pairDocumentsByTitle(oldItem.supportingDocuments, item.supportingDocuments);
    const copyOf = copyNumbers(item.supportingDocuments);
    for (const doc of added) {
      const entry = {
        itemNumber: item.number,
        itemFileNumber: item.fileNumber || '',
        filename: doc.title || doc.originalText || 'Document',
      };
      // A later copy under a title the item already had: the number says
      // which of the same-named links is new (json-to-markdown.js badges
      // only that one). No number means the title itself was new.
      if (copyOf.get(doc) > 1) entry.copy = copyOf.get(doc);
      result.documentsAdded.push(entry);
    }
  }

  return result;
}

const docKey = (doc) => String(doc.title || doc.originalText || '').replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Each document's 1-based position among the same-titled documents of its
 * item, in page order (the "#2" of lib/scrape-guard.js documentKeys).
 * @param {Object[]} docs
 * @returns {Map<Object, number>}
 */
function copyNumbers(docs) {
  const seen = new Map();
  const out = new Map();
  for (const doc of docs || []) {
    const key = docKey(doc);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    out.set(doc, n);
  }
  return out;
}

/**
 * Pair one item's old and new documents by title. URLs can't be the key
 * (publishIds rotate on every republish) and titles repeat within an item:
 * on 10/26/26 the clerk attached the revised Rays CBA memo, Exhibit A and
 * all, under the original's exact filename (meeting 2989). So this counts
 * copies per title instead of testing membership. Copies pair up in page
 * order, the order planDocumentFilenames in document-mirror.js uses to give
 * the later copy its "-2" name, and the surplus on either side is the change.
 * @param {Object[]} oldDocs
 * @param {Object[]} newDocs
 * @returns {{added: Object[], removed: Object[], matched: Array<[Object, Object]>}}
 *   matched holds [oldDoc, newDoc] pairs; untitled documents are ignored.
 */
function pairDocumentsByTitle(oldDocs, newDocs) {
  const unpaired = new Map(); // title key → old copies not yet paired
  for (const doc of oldDocs || []) {
    const key = docKey(doc);
    if (!key) continue;
    if (!unpaired.has(key)) unpaired.set(key, []);
    unpaired.get(key).push(doc);
  }
  const added = [];
  const matched = [];
  for (const doc of newDocs || []) {
    const key = docKey(doc);
    if (!key) continue;
    const copies = unpaired.get(key);
    if (copies && copies.length > 0) matched.push([copies.shift(), doc]);
    else added.push(doc);
  }
  const leftover = new Set([...unpaired.values()].flat());
  const removed = (oldDocs || []).filter(doc => leftover.has(doc));
  return { added, removed, matched };
}

/**
 * Return true if the diff has at least one meaningful change.
 * @param {Object} diff  Result of computeMeetingDiff.
 * @returns {boolean}
 */
function diffIsEmpty(diff) {
  return (
    diff.agendaTypePromoted === null &&
    diff.itemsAdded.length === 0 &&
    diff.itemsRemoved.length === 0 &&
    (diff.documentsAdded || []).length === 0
  );
}

module.exports = { computeMeetingDiff, diffIsEmpty, pairDocumentsByTitle, docKey };

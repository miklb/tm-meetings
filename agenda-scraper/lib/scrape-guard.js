/**
 * Scrape guard — reconcile a fresh scrape against the meeting JSON already
 * on disk before it is written.
 *
 * Two things went wrong before this existed:
 *  - an empty or partly failed scrape (OnBase hiccup, dropped item fetch)
 *    overwrote a good file, and the nightly committed it;
 *  - mirroredUrl stamps were carried forward by document title, so two
 *    same-titled documents in one item shared one stamp.
 *
 * Everything here is pure: it takes the two JSON objects and returns a
 * result. The caller decides what to write and what to log.
 */

'use strict';

/**
 * Stable identity for each document within an item: normalised title plus
 * an ordinal for repeated titles, in page order. OnBase publishIds change
 * when the clerk republishes, so they cannot be the key; page order is what
 * the clerk sees and is stable across re-scrapes.
 * @param {Array<{title?: string, originalText?: string}>} docs
 * @returns {string[]} one key per document
 */
function documentKeys(docs) {
  const seen = new Map();
  return (docs || []).map((doc) => {
    const base = String(doc.title || doc.originalText || '')
      .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

const docCount = (item) => (item.supportingDocuments || []).length;

/**
 * Decide whether a freshly scraped item should replace the stored one.
 * Returns the reason to keep the old item, or null to accept the new one.
 */
function reasonToKeepOld(oldItem, newItem) {
  if (!oldItem) return null;
  if (newItem.error) return `fetch failed: ${newItem.error}`;
  const lostDocs = docCount(oldItem) > 0 && docCount(newItem) === 0;
  const lostBackground = Boolean(oldItem.background) && !newItem.background;
  if (lostDocs && lostBackground) return 'documents and background both missing';
  if (lostDocs) return `all ${docCount(oldItem)} documents missing`;
  return null;
}

/**
 * Merge a fresh scrape with the existing file.
 *
 * @param {object|null} existing  meeting JSON currently on disk (null = first scrape)
 * @param {object} fresh          meeting JSON just scraped
 * @returns {{
 *   refused: string|null,        reason the fresh scrape must NOT be written
 *   data: object,                fresh scrape with preserved fields merged in
 *   keptItems: Array<{number, agendaItemId, reason}>,
 *   restoredMirrors: number
 * }}
 */
function mergeWithExisting(existing, fresh) {
  const result = { refused: null, data: fresh, keptItems: [], restoredMirrors: 0 };
  if (!existing) return result;

  const oldItems = existing.agendaItems || [];
  const newItems = fresh.agendaItems || [];

  if (oldItems.length > 0 && newItems.length === 0) {
    result.refused = `scrape returned 0 items but the stored file has ${oldItems.length}`;
    return result;
  }
  if (newItems.length > 0 && newItems.every((i) => i.error)) {
    result.refused = `every one of ${newItems.length} item fetches failed`;
    return result;
  }

  const oldById = new Map(oldItems.filter((i) => i.agendaItemId).map((i) => [String(i.agendaItemId), i]));

  fresh.agendaItems = newItems.map((newItem) => {
    const oldItem = newItem.agendaItemId ? oldById.get(String(newItem.agendaItemId)) : null;
    const reason = reasonToKeepOld(oldItem, newItem);
    if (reason) {
      result.keptItems.push({ number: newItem.number, agendaItemId: newItem.agendaItemId, reason });
      return oldItem;
    }
    if (oldItem) {
      // Carry mirroredUrl forward by document identity (title + ordinal).
      const oldKeys = documentKeys(oldItem.supportingDocuments);
      const oldByKey = new Map(oldKeys.map((k, i) => [k, oldItem.supportingDocuments[i]]));
      const newKeys = documentKeys(newItem.supportingDocuments);
      newKeys.forEach((key, i) => {
        const prev = oldByKey.get(key);
        if (prev && prev.mirroredUrl && !newItem.supportingDocuments[i].mirroredUrl) {
          newItem.supportingDocuments[i].mirroredUrl = prev.mirroredUrl;
          result.restoredMirrors++;
        }
      });
    }
    return newItem;
  });

  return result;
}

module.exports = { documentKeys, mergeWithExisting, reasonToKeepOld };

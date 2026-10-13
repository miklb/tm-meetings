/**
 * Scrape guard — reconcile a fresh scrape against the meeting JSON already
 * on disk before it is written.
 *
 * Two things went wrong before this existed:
 *  - an empty or partly failed scrape (OnBase hiccup, dropped item fetch)
 *    overwrote a good file, and the nightly committed it;
 *  - mirroredUrl stamps were carried forward by document title, so two
 *    same-titled documents in one item shared one stamp;
 *  - the nightly (no MAPBOX_API_TOKEN in CI) re-scraped items the local run
 *    had geocoded and wrote coordinates: null over them, so map pins came
 *    and went with whichever run was last;
 *  - a page the city was republishing item by item came back with most
 *    items empty (kept) and one item half-published (accepted, 10/12/26).
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
 * Per-item fields the scraper derives from a geocoder or a PDF fetch, which
 * a run without those (CI has no Mapbox token) leaves empty. An empty fresh
 * value never overwrites a stored one; a fresh non-empty value always wins.
 */
const DERIVED_FIELDS = ['coordinates', 'location', 'folioNumbers'];
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

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
 *   restoredMirrors: number,
 *   restoredFields: number   derived fields (coordinates, location, folioNumbers) carried forward
 * }}
 */
function mergeWithExisting(existing, fresh) {
  const result = { refused: null, data: fresh, keptItems: [], restoredMirrors: 0, restoredFields: 0 };
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

  const decisions = newItems.map((newItem) => {
    const oldItem = newItem.agendaItemId ? oldById.get(String(newItem.agendaItemId)) : null;
    return { newItem, oldItem, reason: reasonToKeepOld(oldItem, newItem) };
  });

  // The city republishes a page item by item: items done so far are whole,
  // the item the clerk is on has only the documents published so far, the
  // rest come back empty. The empty ones are kept above; the partial one used
  // to pass. The 10/12/26 nightly accepted REZ-26-74 (meeting 2935) with 1 of
  // 8 documents and wiped seven mirroredUrl stamps, the summary text and the
  // staff report. So when any item came back empty, an item that lost
  // documents is held too. A clerk really pulling one document in the same
  // moment is far rarer than this, and holding it is harmless.
  const emptyItems = decisions.filter((d) =>
    d.oldItem && !d.newItem.error && docCount(d.oldItem) > 0 && docCount(d.newItem) === 0).length;
  if (emptyItems > 0) {
    for (const d of decisions) {
      if (d.reason || !d.oldItem) continue;
      const lost = docCount(d.oldItem) - docCount(d.newItem);
      if (lost > 0) {
        d.reason = `${lost} of ${docCount(d.oldItem)} documents missing while ${emptyItems} other item${emptyItems === 1 ? '' : 's'} came back empty`;
      }
    }
  }

  fresh.agendaItems = decisions.map(({ newItem, oldItem, reason }) => {
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
      for (const field of DERIVED_FIELDS) {
        if (isEmpty(newItem[field]) && !isEmpty(oldItem[field])) {
          newItem[field] = oldItem[field];
          result.restoredFields++;
        }
      }
    }
    return newItem;
  });

  return result;
}

module.exports = { DERIVED_FIELDS, documentKeys, mergeWithExisting, reasonToKeepOld };

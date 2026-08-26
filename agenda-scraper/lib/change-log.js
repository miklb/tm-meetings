/**
 * Change Log — per-meeting change log helpers
 *
 * Each meeting gets a single JSON file at:
 *   agenda-scraper/data/changes/meeting_<id>_<date>.json
 *
 * Shape:
 * {
 *   meetingId:   "2645",
 *   meetingDate: "2025-11-13",
 *   firstSeenAt: "<ISO>",
 *   entries: [
 *     {
 *       date: "2025-11-11",          // UTC date key — one entry per calendar day
 *       scrapedAt: "<ISO>",          // last scraper run that touched this entry
 *       mirroredAt: "<ISO>",         // last mirror run that touched this entry (if any)
 *       agendaTypePromoted: { from: "DRAFT", to: "FINAL" } | null,
 *       itemsAdded:   [{ agendaItemId, number, fileNumber, shortTitle }],
 *       itemsRemoved: [{ agendaItemId, number, fileNumber, shortTitle }],
 *       newDocuments: [{ itemNumber, itemFileNumber, filename }]
 *     }
 *   ]
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CHANGES_DIR = path.join(__dirname, '..', 'data', 'changes');

/**
 * Ensure the changes directory exists.
 */
function ensureChangesDir() {
  if (!fs.existsSync(CHANGES_DIR)) {
    fs.mkdirSync(CHANGES_DIR, { recursive: true });
  }
}

/**
 * Build the file path for a meeting's change log.
 * @param {string|number} meetingId
 * @param {string} formattedDate  YYYY-MM-DD
 * @returns {string}
 */
function changeLogPath(meetingId, formattedDate) {
  ensureChangesDir();
  return path.join(CHANGES_DIR, `meeting_${meetingId}_${formattedDate}.json`);
}

/**
 * Load an existing change log, or return a fresh skeleton.
 * @param {string|number} meetingId
 * @param {string} formattedDate  YYYY-MM-DD
 * @returns {Object}
 */
function loadChangeLog(meetingId, formattedDate) {
  const filePath = changeLogPath(meetingId, formattedDate);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Corrupt file — start fresh
    }
  }
  return {
    meetingId: String(meetingId),
    meetingDate: formattedDate,
    firstSeenAt: null,
    entries: [],
  };
}

/**
 * Persist a change log to disk.
 * @param {Object} log
 */
function saveChangeLog(log) {
  ensureChangesDir();
  const filePath = changeLogPath(log.meetingId, log.meetingDate);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
}

/**
 * Return today's date as YYYY-MM-DD in Tampa local time. The log is a
 * public "what changed on which day" record, so the day boundary has to be
 * the reader's — a 9 PM local run is still that day, not tomorrow UTC.
 * @returns {string}
 */
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Identity key for a logged document: item number + filename with
 * whitespace/case normalised and the extension dropped (the mirror step
 * may swap ".DOCX" for ".DO.pdf" per OnBase's converted download URL).
 * @param {{itemNumber: number|string, filename: string}} doc
 * @returns {string}
 */
function documentKey(doc) {
  const name = String(doc.filename || '')
    .replace(/\.[a-z0-9.]+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return `${doc.itemNumber}::${name}`;
}

/**
 * Return true if a partial entry has at least one meaningful, non-empty field.
 * @param {Object} partial
 * @returns {boolean}
 */
function hasMeaningfulContent(partial) {
  if (partial.agendaTypePromoted) return true;
  if (partial.itemsAdded && partial.itemsAdded.length > 0) return true;
  if (partial.itemsRemoved && partial.itemsRemoved.length > 0) return true;
  if (partial.newDocuments && partial.newDocuments.length > 0) return true;
  return false;
}

/**
 * Merge a partial entry (from a scraper or mirror run) into the log,
 * keying on the current UTC date so multiple same-day runs combine into
 * one entry instead of producing duplicates.
 *
 * Only appends/updates when `partial` contains at least one non-empty field.
 * Documents already logged under *any* day are skipped, so a document the
 * nightly scraper dated on Tuesday isn't re-dated when it is mirrored on
 * Wednesday.
 *
 * @param {Object} log       The log object (mutated in place).
 * @param {Object} partial   Fields to add/update for today's entry.
 * @param {string} [dateKey] YYYY-MM-DD to file under (default: today, local).
 * @returns {boolean}        True when the log was actually modified.
 */
function appendOrMergeEntry(log, partial, dateKey = todayLocal()) {
  if (partial.newDocuments && partial.newDocuments.length > 0) {
    const seen = new Set();
    for (const e of log.entries) {
      for (const d of e.newDocuments || []) seen.add(documentKey(d));
    }
    partial = { ...partial, newDocuments: partial.newDocuments.filter(d => !seen.has(documentKey(d))) };
  }
  if (!hasMeaningfulContent(partial)) return false;

  let entry = log.entries.find(e => e.date === dateKey);

  if (!entry) {
    entry = { date: dateKey };
    log.entries.push(entry);
  }

  // Scraper fields
  if (partial.scrapedAt !== undefined) entry.scrapedAt = partial.scrapedAt;
  if (partial.agendaTypePromoted !== undefined) entry.agendaTypePromoted = partial.agendaTypePromoted;
  if (partial.itemsAdded !== undefined) entry.itemsAdded = partial.itemsAdded;
  if (partial.itemsRemoved !== undefined) entry.itemsRemoved = partial.itemsRemoved;

  // Mirror fields — merge doc lists so multiple mirror runs don't clobber each other
  if (partial.mirroredAt !== undefined) entry.mirroredAt = partial.mirroredAt;
  if (partial.newDocuments && partial.newDocuments.length > 0) {
    if (!entry.newDocuments) {
      entry.newDocuments = [];
    }
    // De-duplicate by itemNumber+filename
    const existing = new Set(entry.newDocuments.map(documentKey));
    for (const doc of partial.newDocuments) {
      const key = documentKey(doc);
      if (!existing.has(key)) {
        entry.newDocuments.push(doc);
        existing.add(key);
      }
    }
  }

  // Keep entries sorted newest first
  log.entries.sort((a, b) => (b.date > a.date ? 1 : -1));

  return true;
}

module.exports = { loadChangeLog, saveChangeLog, appendOrMergeEntry };

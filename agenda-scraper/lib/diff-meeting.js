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

  return result;
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
    diff.itemsRemoved.length === 0
  );
}

module.exports = { computeMeetingDiff, diffIsEmpty };

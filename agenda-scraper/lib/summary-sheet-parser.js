/**
 * Summary-sheet helpers for Tampa City Council agenda PDFs.
 *
 * Tampa "Summary Sheet- COVER SHEET" PDFs follow a consistent layout:
 *
 *   ...header / metadata...
 *   BACKGROUND:
 *     <free-form prose, may include numbered items, may span pages>
 *   FISCAL IMPACT:
 *   FISCAL IMPACT STATEMENT:
 *   PROJECTED COSTS:
 *   <occasionally:> RECOMMENDATION:, ATTACHMENTS:, REVIEWED BY:, PREPARED BY:
 *
 * Section labels are ALWAYS uppercase and end with a colon. Anchoring the
 * Background extractor on that pattern avoids the historical bug where the
 * regex would truncate at any line starting with the word "recommendation"
 * (or "fiscal impact", etc.) appearing in the middle of normal sentences.
 */

// Headers that may legitimately follow BACKGROUND: in a summary sheet.
// Matched case-sensitively (uppercase) with a trailing colon to avoid
// false positives on body text that happens to start with the same word.
// We accept either a preceding newline OR the very start of the slice
// (covers the common empty-Background case where the BACKGROUND label
// is immediately followed by the next section header).
const NEXT_SECTION_RE = new RegExp(
  '(?:^|\\n)\\s*(?:' +
    [
      'FISCAL\\s+IMPACT(?:\\s+STATEMENT)?',
      'PROJECTED\\s+COSTS?',
      'RECOMMENDATION',
      'STAFF\\s+RECOMMENDATION',
      'ATTACHMENTS?',
      'CONCLUSION',
      'NEXT\\s+STEPS',
      'JUSTIFICATION',
      'ALTERNATIVES',
      'CONTACT',
      'PREPARED\\s+BY',
      'REVIEWED\\s+BY',
      'BUDGET',
      'LEGAL',
      'ANALYSIS',
      'APPROVER\\s+TIMESTAMP',  // boilerplate at end of OnBase summary sheets
    ].join('|') +
    ')\\s*:'
);

/**
 * Extract Background prose from raw summary-sheet PDF text.
 *
 * Returns an empty string if no Background section is found, or if the
 * section is empty (Tampa often submits sheets with `BACKGROUND:` followed
 * immediately by `FISCAL IMPACT:` and no body text).
 *
 * @param {string} text - Plain-text PDF output (any backend)
 * @returns {string} - Trimmed background body, or '' if missing/empty
 */
function extractBackgroundSection(text) {
  if (!text) return '';

  // 1. Find the Background label (case-insensitive — header itself is uppercase
  //    in source but be tolerant). Allow optional `INFORMATION` / `PROJECT` prefixes.
  const labelRe = /(?:^|\n)\s*(?:PROJECT\s+)?BACKGROUND(?:\s+INFORMATION)?\s*:?\s*\n/i;
  const labelMatch = labelRe.exec(text);
  if (!labelMatch) return '';

  const startIdx = labelMatch.index + labelMatch[0].length;
  const remainder = text.slice(startIdx);

  // 2. Find the next uppercase-with-colon section header.
  const nextMatch = NEXT_SECTION_RE.exec(remainder);
  const body = (nextMatch ? remainder.slice(0, nextMatch.index) : remainder).trim();

  // Reject "Approver Timestamp Role"-only tails (no real content).
  if (!body || body.length < 4) return '';

  return body;
}

module.exports = {
  extractBackgroundSection,
  NEXT_SECTION_RE,
};

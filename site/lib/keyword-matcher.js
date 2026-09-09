// Keyword matching and subscriber eligibility, shared by:
//   site/functions/api/notify.js     — the production dispatcher
//   scripts/preview-dispatch.js      — the read-only dry run
//   scripts/test-matching.js         — the historical matching report
//   site/functions/api/subscribe.js, manage.js — eligibility only
//
// Before this module each of those carried its own copy, and they drifted:
// the preview lacked the street-suffix expansion, so it under-reported what
// the real dispatch would send. Lives outside site/functions/ so it is never
// exposed as a route. ESM; Node (>= 22.12) can require() it from CommonJS.

export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fuzzy street-suffix matching: lets a keyword typed as "Bayshore Blvd" match
// agenda text that says "Bayshore Boulevard" (or "Bayshore Blvd."), and vice
// versa, regardless of which form the subscriber typed or the source text
// uses. Each group's bare (period-stripped) forms map to a regex alternation
// covering every variant in that group.
const STREET_SUFFIX_GROUPS = [
  ['st', 'st.', 'street'],
  ['ave', 'ave.', 'avenue'],
  ['blvd', 'blvd.', 'boulevard'],
  ['dr', 'dr.', 'drive'],
  ['rd', 'rd.', 'road'],
  ['ln', 'ln.', 'lane'],
  ['ct', 'ct.', 'court'],
  ['pl', 'pl.', 'place'],
  ['cir', 'cir.', 'circle'],
  ['pkwy', 'pkwy.', 'parkway'],
  ['hwy', 'hwy.', 'highway'],
  ['ter', 'ter.', 'terrace'],
];

// A trailing period can't be followed by a `\b` (a period and the space that
// usually follows it are both non-word characters, so no boundary exists
// between them) — only the non-abbreviated variants get a trailing boundary.
function suffixVariantPattern(variant) {
  const escaped = escapeRegExp(variant);
  return variant.endsWith('.') ? `\\b${escaped}` : `\\b${escaped}\\b`;
}

const STREET_SUFFIX_LOOKUP = new Map();
for (const group of STREET_SUFFIX_GROUPS) {
  const pattern = `(?:${group.map(suffixVariantPattern).join('|')})`;
  for (const variant of group) {
    STREET_SUFFIX_LOOKUP.set(variant.replace(/\.$/, ''), pattern);
  }
}

// Builds a regex source string for a keyword, expanding any street-suffix
// word into an alternation matching every variant in its group; other words
// are matched literally.
export function buildFuzzyPattern(keyword) {
  return keyword
    .split(/\s+/)
    .map(word => STREET_SUFFIX_LOOKUP.get(word.replace(/\.$/, '')) || escapeRegExp(word))
    .join('\\s+');
}

// Keywords this short are nearly always acronyms or proper nouns (MOU, CRA,
// Ybor), and substring matching makes them fire inside unrelated words —
// "mou" hits every "amount" on an agenda. They get whole-word matching
// instead, with an optional plural s ("MOU" still catches "MOUs"). Longer
// keywords keep plain substring semantics so stems still match ("zoning"
// catches "rezoning").
export const SHORT_KEYWORD_MAX = 4;

export function containsPattern(keyword) {
  const fuzzy = buildFuzzyPattern(keyword);
  return keyword.length <= SHORT_KEYWORD_MAX ? `\\b${fuzzy}s?\\b` : fuzzy;
}

// Fields are joined with a non-whitespace separator so a multi-word keyword
// cannot match across the end of one field and the start of the next
// ("… Bayshore" + "Boulevard …" in the next document title).
export const FIELD_SEP = ' · ';

/** The exact lowercased text an agenda item is matched against. */
export function searchableText(item) {
  const sr = item.staffReport;
  const staffReportText = sr
    ? [
        sr.currentZoning || '',
        sr.requestedZoning || '',
        sr.futureLandUse || '',
        sr.overlayDistrict || '',
        ...(sr.neighborhoodAssociations || []),
        ...(sr.waivers || []),
        sr.findings || '',
      ].join(FIELD_SEP)
    : '';

  return [
    item.title || '',
    item.background || '',
    item.fileNumber || '',
    ...(item.supportingDocuments || []).map(d => d.title || ''),
    staffReportText,
  ].join(FIELD_SEP).toLowerCase();
}

/**
 * Compile matchers once per dispatch.
 * @param {Array<{keyword: string, matchType: string}>} keywords  normalised (trimmed, lowercased)
 */
export function buildMatchers(keywords) {
  const uniq = (type) => [...new Set(keywords.filter(k => k.matchType === type).map(k => k.keyword))];
  // One regex per keyword (rather than one combined alternation) so a match
  // can be attributed straight back to the keyword that produced it — needed
  // now that fuzzy street-suffix expansion means the matched text doesn't
  // always equal the keyword text verbatim.
  return {
    contains: uniq('contains').map(kw => ({ keyword: kw, regex: new RegExp(containsPattern(kw), 'i') })),
    exact: uniq('exact_phrase').map(kw => ({ keyword: kw, regex: new RegExp(`\\b${buildFuzzyPattern(kw)}\\b`, 'i') })),
    fileNumbers: new Set(uniq('file_number')),
  };
}

/**
 * Match one agenda item. Returns the set of "matchType:keyword" keys that hit.
 * @param {object} item
 * @param {ReturnType<typeof buildMatchers>} matchers
 * @param {string} [text]  precomputed searchableText(item)
 */
export function matchItem(item, matchers, text = searchableText(item)) {
  const hits = new Set();
  for (const { keyword, regex } of matchers.contains) {
    if (regex.test(text)) hits.add(`contains:${keyword}`);
  }
  for (const { keyword, regex } of matchers.exact) {
    if (regex.test(text)) hits.add(`exact_phrase:${keyword}`);
  }
  const fileNumber = (item.fileNumber || '').toLowerCase();
  if (fileNumber && matchers.fileNumbers.has(fileNumber)) {
    hits.add(`file_number:${fileNumber}`);
  }
  return hits;
}

/** Split a "matchType:keyword" key on the first colon only — keywords may contain colons. */
export function splitMatchKey(key) {
  const i = key.indexOf(':');
  return { matchType: key.slice(0, i), keyword: key.slice(i + 1) };
}

/**
 * Identity of an agenda item for dedup and digest grouping. Items without an
 * OnBase agendaItemId (five exist across three 2025-26 meetings) used to
 * collapse into one digest entry keyed "undefined"; the item number keeps
 * them apart within a meeting.
 */
export function itemKey(item) {
  return item.agendaItemId ? String(item.agendaItemId) : `n${item.number ?? '?'}`;
}

// Every allowed subscriber gets the same cap; the tiers only decide who is
// allowed in the gated modes.
export const KEYWORD_LIMIT = 15;

/**
 * Registration-mode eligibility. One rule for notify, preview, subscribe and
 * manage (they used to disagree: notify admitted beta testers under
 * SUPPORTERS_ONLY, the others did not).
 *
 * @param {{ isSupporter: boolean, supporterActiveUntil: string|null, isBetaTester: boolean }} who
 * @param {string} regMode  PUBLIC | BETA_AND_SUPPORTERS | SUPPORTERS_ONLY
 * @param {Date} [now]
 * @returns {{ allowed: boolean, limit: number }}
 */
export function eligibility(who, regMode = 'SUPPORTERS_ONLY', now = new Date()) {
  const activeSupporter = who.isSupporter &&
    (who.supporterActiveUntil === null || who.supporterActiveUntil === undefined ||
      new Date(who.supporterActiveUntil) > now);
  const allowed = activeSupporter ||
    regMode === 'PUBLIC' ||
    (regMode === 'BETA_AND_SUPPORTERS' && Boolean(who.isBetaTester));
  return { allowed, limit: KEYWORD_LIMIT };
}

/** Eligibility from the joined subscriber row notify.js and preview-dispatch.js read. */
export function eligibilityFromRow(row, regMode, now) {
  return eligibility({
    isSupporter: row.supporter_email !== null && row.supporter_email !== undefined,
    supporterActiveUntil: row.supporter_active_until ?? null,
    isBetaTester: row.is_beta_tester === 1,
  }, regMode, now);
}

/** Split an array into arrays of at most `size`. */
export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// D1 allows 100 bound parameters per statement. Meeting 2824 has 119 items;
// an IN (...) with one bind per item threw, the error was swallowed, and the
// empty dedup set re-emailed everyone on the next dispatch.
export const D1_MAX_BINDS = 90;

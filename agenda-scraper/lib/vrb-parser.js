/**
 * Variance Review Board agenda parser.
 *
 * Input is the plain text pdf-parse produces from a VRB agenda PDF (see
 * lib/pdf-text-extractor.js). The template is one numbered block per case:
 *
 *   1. VRB-26-28 (Continued from April 14, Hearing)
 *   Owner/Applicant: Kevin James and Jessica Lane Bexley/Mark Blanar
 *   Location: 4510 S Ferncroft Circle
 *   Folio: 120606.0000
 *   Zoning: Residential Single Family (RS-75)
 *   Request: Reduce rear yard setback from 20 feet to 5 feet
 *   Code Section: 27-156
 *   Neighborhood Association: Culbreath Bayou Homeowners Association Inc.
 *
 * Every rule below was derived from the ten agendas the City had posted as of
 * 2026-09-20 (100 cases, all seven labels present in each) and is pinned by
 * test/vrb.test.js against fixtures cut from them. The parser is pure: no
 * network, no filesystem.
 */

'use strict';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Label → output field, in template order.
const FIELDS = [
  ['Owner/Applicant', 'ownerApplicant'],
  ['Location', 'location'],
  ['Folio', 'folio'],
  ['Zoning', 'zoning'],
  ['Request', 'request'],
  ['Code Section', 'codeSection'],
  ['Neighborhood Association', 'neighborhoodAssociationsRaw'],
];
const FIELD_BY_LABEL = new Map(FIELDS.map(([label, key]) => [label.toLowerCase(), key]));
const LABEL_LINE = new RegExp(
  `^(${FIELDS.map(([label]) => label.replace('/', '\\/')).join('|')})s?\\s*:\\s*(.*)$`, 'i'
);

// "7. VRB-26-27 (Requested Continue to June 9, 2026)" — minutes drop the space
// after the dot ("3.VRB-26-11"), so it is optional.
const CASE_LINE = /^(\d{1,2})\.\s*(VRB-\d{2}-\d+)\b\s*(.*)$/i;

// Sub-headings the clerk puts between cases (3 of 10 agendas). They sit after
// the previous case's last field, so without this they would be swallowed as
// a continuation of its Neighborhood Association list.
const SECTION_LINE = /^(Continued Cases|New Business)$/i;

// pdf-parse emits each page number as a line of its own, often mid-case.
const PAGE_NUMBER_LINE = /^\d{1,2}$/;

// Cases end at the next roman-numeral heading. Today that is always
// "VII. Adjournment", but an "Other Business" heading added ahead of it must
// not be swallowed into the last case's association list.
const END_OF_CASES = /^(?:[IVX]{1,4}\.\s+\S|In accordance with the Americans)/;

// "Bayshore Beautiful Neighborhood Association, Inc." is one name, not two.
const NAME_SUFFIX = /^(?:Inc|LLC|Incorporated)\.?$/i;

function cleanLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !PAGE_NUMBER_LINE.test(line));
}

/**
 * Hearing date, time and place from the header. Superscript ordinals come out
 * of pdf-parse on their own lines ("July 14" / "th" / ", 2026"), so the header
 * is flattened before matching.
 * @returns {{hearingDate: string|null, hearingTime: string|null, location: string|null}}
 */
function parseHeader(text) {
  const flat = cleanLines(text).join(' ');
  const header = flat.match(/MEETING DATE\/TIME:\s*(.*?)\s*LOCATION:\s*(.*?)\s*(?:AGENDA|Meeting Minutes)\b/i);
  if (!header) return { hearingDate: null, hearingTime: null, location: null };

  const time = header[1].match(/(\d{1,2}:\d{2})\s*([AP])\.?M/i);
  const weekday = header[1].match(new RegExp(`\\b(${WEEKDAYS.join('|')})\\b`, 'i'));

  return {
    hearingDate: findDate(header[1]),
    headerWeekday: weekday ? weekday[1].toLowerCase() : null,
    hearingTime: time ? `${time[1]} ${time[2].toUpperCase()}M` : null,
    location: header[2] || null,
  };
}

/**
 * First "Month D, YYYY" in a string, as YYYY-MM-DD.
 * @returns {string|null}
 */
function findDate(str) {
  const flat = String(str || '').replace(/(\d)\s*(?:st|nd|rd|th)\b/gi, '$1');
  const date = flat.match(/([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})/);
  const month = date ? MONTHS.indexOf(date[1].toLowerCase()) : -1;
  if (month < 0) return null;
  return `${date[3]}-${String(month + 1).padStart(2, '0')}-${date[2].padStart(2, '0')}`;
}

const weekdayOf = (isoDate) => WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];

/**
 * The hearing date a document belongs to. The header is typed by hand and the
 * March 10, 2026 minutes say "Tuesday, March 13, 2026" (a Friday), so the
 * weekday is used as a checksum: when it contradicts the header's date, the
 * date in the document title wins if the weekday agrees with that one.
 * @param {string} text  - pdf-parse output
 * @param {string} title - document title from tampa.gov ("VRB Minutes - March 10, 2026")
 * @returns {{hearingDate: string|null, warnings: string[]}}
 */
function resolveHearingDate(text, title) {
  const { hearingDate, headerWeekday } = parseHeader(text);
  if (!hearingDate) return { hearingDate: findDate(title), warnings: ['No hearing date in the PDF header'] };
  if (!headerWeekday || weekdayOf(hearingDate) === headerWeekday) return { hearingDate, warnings: [] };

  const titleDate = findDate(title);
  const mismatch = `PDF header says ${headerWeekday} ${hearingDate}, which is a ${weekdayOf(hearingDate)}`;
  if (titleDate && weekdayOf(titleDate) === headerWeekday) {
    return { hearingDate: titleDate, warnings: [`${mismatch}; using ${titleDate} from the document title`] };
  }
  return { hearingDate, warnings: [`${mismatch}; no better date found`] };
}

/**
 * Split the City's notified-associations list into names.
 * @param {string} raw
 * @returns {string[]} de-duplicated, in the City's order
 */
function splitAssociations(raw) {
  const names = [];
  for (const token of String(raw || '').split(/,\s*/).map((t) => t.trim()).filter(Boolean)) {
    if (NAME_SUFFIX.test(token) && names.length) {
      names[names.length - 1] += `, ${token}`;
    } else {
      names.push(token);
    }
  }
  return [...new Set(names)];
}

function finishCase(c) {
  for (const [, key] of FIELDS) c[key] = (c[key] || '').trim() || null;

  const slash = (c.ownerApplicant || '').indexOf('/');
  c.owner = slash === -1 ? c.ownerApplicant : c.ownerApplicant.slice(0, slash).trim();
  c.applicant = slash === -1 ? null : c.ownerApplicant.slice(slash + 1).trim();
  c.neighborhoodAssociations = splitAssociations(c.neighborhoodAssociationsRaw);
  return c;
}

/**
 * @param {string} text - pdf-parse output for one agenda
 * @returns {{hearingDate: string|null, hearingTime: string|null, location: string|null,
 *            cases: object[], warnings: string[]}}
 */
function parseVrbAgenda(text) {
  const lines = cleanLines(text);
  const cases = [];
  const warnings = [];
  let current = null;
  let field = null;
  let section = null;

  const start = lines.findIndex((line) => /ITEMS TO BE REVIEWED/i.test(line));
  if (start === -1) warnings.push('No "ITEMS TO BE REVIEWED" heading found');

  for (const line of lines.slice(start + 1)) {
    if (END_OF_CASES.test(line)) break;

    const caseMatch = line.match(CASE_LINE);
    if (caseMatch) {
      if (current) cases.push(finishCase(current));
      current = {
        itemNumber: Number(caseMatch[1]),
        caseNumber: caseMatch[2].toUpperCase(),
        note: caseMatch[3].replace(/^\(\s*/, '').replace(/\s*\)$/, '').trim() || null,
        section,
      };
      field = null;
      continue;
    }

    if (SECTION_LINE.test(line)) {
      section = line;
      field = null;
      continue;
    }

    if (!current) continue;

    const labelMatch = line.match(LABEL_LINE);
    if (labelMatch) {
      field = FIELD_BY_LABEL.get(labelMatch[1].toLowerCase());
      current[field] = labelMatch[2];
      continue;
    }

    if (field) {
      // Numbered sub-requests ("2. Reduce vehicular entrance setback…") keep
      // their own line; everything else is a wrapped line.
      const glue = field === 'request' && /^\d+\.\s/.test(line) ? '\n' : ' ';
      current[field] = current[field] ? `${current[field]}${glue}${line}` : line;
    }
  }
  if (current) cases.push(finishCase(current));

  for (const c of cases) {
    const missing = FIELDS.filter(([, key]) => !c[key]).map(([label]) => label);
    if (missing.length) warnings.push(`${c.caseNumber}: missing ${missing.join(', ')}`);
    // The clerk types folios by hand: "120606.0000", "12016.0000" and
    // "142973-0000" all occur. Stored as typed; anything else gets flagged.
    if (c.folio && !/^\d{5,6}[.-]\d{4}$/.test(c.folio)) {
      warnings.push(`${c.caseNumber}: unexpected folio format "${c.folio}"`);
    }
  }
  cases.forEach((c, i) => {
    if (c.itemNumber !== i + 1) warnings.push(`${c.caseNumber}: item number ${c.itemNumber} at position ${i + 1}`);
  });

  const { hearingDate, hearingTime, location } = parseHeader(text);
  if (!hearingDate) warnings.push('No hearing date found in header');

  return { hearingDate, hearingTime, location, cases, warnings };
}

module.exports = { parseVrbAgenda, parseHeader, resolveHearingDate, findDate, splitAssociations };

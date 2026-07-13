/**
 * Projected Costs Parser
 *
 * Tampa Summary Sheet PDFs include a `PROJECTED COSTS:` section that is the
 * only authoritative source of per-resolution budget actions. This parser
 * extracts table rows from that section and the FISCAL IMPACT STATEMENT
 * paragraph for display. It deliberately does NOT scan BACKGROUND, the title,
 * or any other section for dollar amounts — those produce duplicates of
 * numbers already captured in PROJECTED COSTS, or context that is not a
 * budget action this resolution effects.
 *
 * Row shape (two known formats):
 *   12520 228990 331205 1002686 $26,000 (Revenue Decrease)
 *   01100.215000.552003 FY26 $330,665.99 (Estimated Expenditure)
 *   01100.215000.552003 FY27 $330,665.98 (Estimated Expenditure), subject to annual appropriation
 *
 * Account code: fund(5) + dept(6) + object(6) + project(7, optional)
 * Separators between segments may be whitespace OR period. Fiscal year
 * marker `FY26` is optional. The trailing parenthesized phrase carries the
 * type marker. "subject to annual appropriation" is a flag indicating
 * Council is NOT committing this fiscal year today.
 */

const { NEXT_SECTION_RE } = require('./summary-sheet-parser');

// OnBase summary sheets append a sign-off log after PROJECTED COSTS that
// reads "ApproverTimestampRole <Name><Date>..." with NO leading newline
// and NO trailing colon, so NEXT_SECTION_RE doesn't catch it. We strip
// it explicitly here so the row description doesn't sweep up the entire
// approval chain.
const APPROVER_BOILERPLATE_RE = /\bApprover\s*Timestamp\s*Role\b/i;

/**
 * Slice the PROJECTED COSTS: section out of raw summary-sheet text.
 * Returns the section body (without the label) or '' if not present.
 */
function extractProjectedCostsSection(text) {
  if (!text) return '';
  const labelRe = /(?:^|\n)\s*PROJECTED\s+COSTS?\s*:\s*/i;
  const m = labelRe.exec(text);
  if (!m) return '';
  const start = m.index + m[0].length;
  let remainder = text.slice(start);
  const next = NEXT_SECTION_RE.exec(remainder);
  if (next) remainder = remainder.slice(0, next.index);
  const approver = APPROVER_BOILERPLATE_RE.exec(remainder);
  if (approver) remainder = remainder.slice(0, approver.index);
  return remainder.trim();
}

/**
 * Slice the FISCAL IMPACT STATEMENT: paragraph (one or more sentences,
 * ending at the next uppercase header). Returns trimmed body or ''.
 */
function extractFiscalImpactStatement(text) {
  if (!text) return '';
  const labelRe = /(?:^|\n)\s*FISCAL\s+IMPACT\s+STATEMENT\s*:\s*/i;
  const m = labelRe.exec(text);
  if (!m) return '';
  const start = m.index + m[0].length;
  const remainder = text.slice(start);
  const next = NEXT_SECTION_RE.exec(remainder);
  return (next ? remainder.slice(0, next.index) : remainder).trim().replace(/\s+/g, ' ');
}

// Account-code segment pattern. Period or whitespace separated; project
// segment (4th group) is optional. Used both as the row anchor and on its
// own to extract the canonical code from a row's text.
const ACCOUNT_CODE_RE =
  /(\d{5})[.\s]+(\d{6})[.\s]+(\d{6})(?:[.\s]+(\d{7}))?/;

// Anchor for splitting the section into rows. Each match starts a new row;
// the row's full text runs from one match to the next (or end of section).
const ACCOUNT_CODE_ANCHOR_RE = new RegExp(ACCOUNT_CODE_RE.source, 'g');

// Within a single row's text, these patterns are matched independently so
// element ORDER doesn't matter (Tampa staff produce both
// "<code> FY26 $X (Type)" and "<code> $X FY2026 (Type)" formats).
const FY_RE = /\bFY\s*(?:20)?(\d{2})\b/i;
const AMOUNT_RE = /\$([\d,]+(?:\.\d{2})?)/;
// MARKER_RE is now global so we can iterate all parenthesized groups in a
// row and skip any whose content is a bare dollar amount (e.g. "($294,318)").
// Tampa staff use that negative-amount convention for decreases, which means
// the type marker like "(Expenditure Decrease)" appears AFTER the amount.
const MARKER_RE = /\(([^)]+)\)/g;
// Pattern to detect a parens group that is just a dollar amount, not a type
// marker. These must be skipped when searching for the type marker.
const DOLLAR_ONLY_RE = /^\$?[\d,]+(?:\.\d{2})?$/;
// Subject-to-appropriation: phrase may wrap across line breaks, so use
// \s+ between every word.
const SUBJECT_RE = /subject\s+to\s+annual\s+appropriation/i;

/**
 * Map the parenthesized type marker to a normalized type and budget sign.
 *
 * Returned `signedDirection` describes how this row affects the City's
 * net cash position THIS fiscal year:
 *   +1  the City spends more (or loses revenue it was counting on)
 *   -1  the City spends less (or gains revenue)
 *    0  unrecognized — caller should treat as a parse error
 */
function classifyTypeMarker(marker) {
  const m = (marker || '').toLowerCase().trim();
  if (m.includes('revenue decrease')) {
    return { type: 'revenue_decrease', signedDirection: +1 };
  }
  if (m.includes('expenditure decrease') || m === 'decrease') {
    return { type: 'expenditure_decrease', signedDirection: -1 };
  }
  if (m.includes('revenue')) {
    return { type: 'revenue', signedDirection: -1 };
  }
  if (m.includes('expenditure') || m.includes('expense') || m.includes('appropriation')) {
    return { type: 'expenditure', signedDirection: +1 };
  }
  return { type: 'unknown', signedDirection: 0 };
}

/**
 * Parse a normalized dollar string ("330,665.99") into a number.
 */
function parseDollarValue(s) {
  const n = parseFloat(String(s).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Slice raw section text into per-row fragments, anchored on account-code
 * occurrences. Each returned fragment runs from the start of one account
 * code through the start of the next (or end of section).
 *
 * Description text following the account row (e.g. "General Fund. Fire Dept.")
 * is included with that row but stripped before storing.
 */
function _splitRows(sectionText) {
  if (!sectionText) return [];
  const matches = [];
  ACCOUNT_CODE_ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ACCOUNT_CODE_ANCHOR_RE.exec(sectionText)) !== null) {
    matches.push(m);
  }
  const fragments = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : sectionText.length;
    fragments.push({ rowText: sectionText.slice(start, end), accountMatch: matches[i] });
  }
  return fragments;
}

/**
 * Extract structured rows from the PROJECTED COSTS section.
 *
 * Returns an array of:
 *   {
 *     accountCode: "01100.215000.552003.1002686" | "01100.215000.552003",
 *     fund, department, object, project: string | null,
 *     fiscalYear: "FY26" | null,
 *     amount: "$330,665.99",
 *     value: 330665.99,
 *     type: "expenditure" | "expenditure_decrease" | "revenue" | "revenue_decrease",
 *     signedValue: number,
 *     subjectToAppropriation: boolean,
 *     marker: string,
 *     description: string,
 *     rawRow: string                 // for debugging unparseable cases
 *   }
 *
 * Rows missing a dollar amount or a recognizable type marker are dropped
 * (and the rawRow is logged on stderr) so they don't quietly produce $0
 * entries downstream.
 */
function parseProjectedCostsRows(sectionText) {
  if (!sectionText) return [];
  const fragments = _splitRows(sectionText);
  const rows = [];

  // The description text that follows an account-code row. We separate
  // it from row metadata by taking everything after the LAST of the
  // amount/FY/marker/subject matches.
  for (const frag of fragments) {
    const text = frag.rowText;
    const codeMatch = ACCOUNT_CODE_RE.exec(text);
    if (!codeMatch) continue;

    const amountMatch = AMOUNT_RE.exec(text);
    // Find the type-marker parens group, skipping any group whose content is
    // a bare dollar amount (e.g. "($294,318)" in decrease rows).
    MARKER_RE.lastIndex = 0;
    let markerMatch = null;
    let m;
    while ((m = MARKER_RE.exec(text)) !== null) {
      if (!DOLLAR_ONLY_RE.test(m[1].trim())) {
        markerMatch = m;
        break;
      }
    }
    const fyMatch = FY_RE.exec(text);
    const subjectMatch = SUBJECT_RE.exec(text);

    if (!amountMatch || !markerMatch) {
      if (process.env.PROJECTED_COSTS_DEBUG) {
        console.warn('[projected-costs-parser] dropping unparseable row:', JSON.stringify(text.slice(0, 200)));
      }
      continue;
    }

    const value = parseDollarValue(amountMatch[1]);
    // Normalize whitespace before classifying. A marker like "(Expenditure
    // Decrease)" can wrap across a line break in the source PDF, leaving a
    // newline inside the captured text ("Expenditure \nDecrease") that would
    // defeat the literal-space substring checks in classifyTypeMarker and
    // mis-type a decrease as an increase.
    const normalizedMarker = markerMatch[1].replace(/\s+/g, ' ').trim();
    const { type, signedDirection } = classifyTypeMarker(normalizedMarker);
    const fyStr = fyMatch ? `FY${fyMatch[1]}` : null;
    const subjectToAppropriation = Boolean(subjectMatch);

    const [, fund, dept, obj, project] = codeMatch;
    const segments = [fund, dept, obj, project].filter(Boolean);

    // Description = text AFTER the latest of {accountCode, amount, marker,
    // fy, subject} occurrences AND before the next row.
    const ends = [
      codeMatch.index + codeMatch[0].length,
      amountMatch.index + amountMatch[0].length,
      markerMatch.index + markerMatch[0].length,
      fyMatch ? fyMatch.index + fyMatch[0].length : 0,
      subjectMatch ? subjectMatch.index + subjectMatch[0].length : 0,
    ];
    const descStart = Math.max(...ends);
    const description = text
      .slice(descStart)
      .replace(/^[\s,]+/, '')
      .replace(/\s+/g, ' ')
      .trim();

    rows.push({
      accountCode: segments.join('.'),
      fund,
      department: dept,
      object: obj,
      project: project || null,
      fiscalYear: fyStr,
      amount: `$${amountMatch[1]}`,
      value,
      type,
      signedValue: value * signedDirection,
      subjectToAppropriation,
      marker: normalizedMarker,
      description,
    });
  }

  return rows;
}

/**
 * Top-level API: parse the relevant fiscal data out of a Summary Sheet PDF
 * text. Returns an object with everything the downstream renderer needs.
 *
 *   {
 *     fiscalImpactStatement: string,   // verbatim sentence(s) for display
 *     projectedCostsRaw: string,       // section body, for fallback display
 *     rows: [...],                     // structured rows (see above)
 *     hasProjectedCosts: boolean,      // section was present
 *     hasParsedRows: boolean           // at least one row matched the regex
 *   }
 */
function parseFiscalSections(summaryText) {
  const projectedCostsRaw = extractProjectedCostsSection(summaryText);
  const rows = parseProjectedCostsRows(projectedCostsRaw);
  return {
    fiscalImpactStatement: extractFiscalImpactStatement(summaryText),
    projectedCostsRaw,
    rows,
    hasProjectedCosts: Boolean(projectedCostsRaw),
    hasParsedRows: rows.length > 0,
  };
}

module.exports = {
  extractProjectedCostsSection,
  extractFiscalImpactStatement,
  parseProjectedCostsRows,
  parseFiscalSections,
  classifyTypeMarker,
  ACCOUNT_CODE_RE,
};

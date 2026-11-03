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
 * Row shape. Most sheets lead with the account code:
 *   12520 228990 331205 1002686 $26,000 (Revenue Decrease)
 *   01100.215000.552003 FY26 $330,665.99 (Estimated Expenditure)
 *   01100.215000.552003 FY27 $330,665.98 (Estimated Expenditure), subject to annual appropriation
 *   12220.218800.534007.TBD (FY28) - $225,000 (Expenditure)
 *   01100.228905.546002 FY27 $48,400 Estimated Amount, subject to annual appropriation
 *   41000.244300.546002 FY2025 $14,698
 * Some lead with the amount, or have no code to lead with:
 *   $28,583 01100.228990.546000 FY26 (Expenditure)
 *   Fiscal Impact: $55,072.00 (Expenditure Increase) Account: 62200.243000.560005.1001518
 *   Controlled by Requisition FY2026 $632,000 Estimated Amount
 *   Funding of $81,546,855 (Expenditure) <one or more codes on the lines below>
 * Agenda totals are checked against the title and fiscal statement in
 * lib/agenda-stats.js, which is where a shape this file misses will surface.
 *
 * Account code: fund(5) + dept(6) + object(6) + project(7, optional)
 * Separators between segments may be whitespace, period or hyphen. Some
 * sheets write the full ledger string with placeholder segments that the
 * chart of accounts has no node for; they are skipped, the project is kept:
 *   31400.243000.560005.0000.1000576          0000 program placeholder
 *   41100.243200.563001.0000.1001865.0000000  + trailing task placeholder
 *   31630.214400.562001.1000986.0000          trailing placeholder only
 *   01100-232900-534007-0000000               all-zero project = no project
 * (shapes counted across every scraped meeting on 2026-10-11; the 4-digit
 * placeholder was 0000 in all 36 occurrences). Fiscal year marker `FY26` is
 * optional. A parenthesized phrase usually carries the type marker; with none,
 * the object code gives the type (3xxxxx revenue, 5xxxxx spending).
 * "subject to annual appropriation" is a flag indicating Council is NOT
 * committing this fiscal year today.
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

// Account-code segment pattern. Period, whitespace or hyphen separated, and
// sometimes not separated at all (61800213801319100$2,015,250, 8/21/25 item
// 11); project segment (4th group) is optional. The object segment accepts a
// dropped digit (12500.228990.55100.1002929, 12/18/25 item 7) so the typo'd
// row keeps its own amount instead of vanishing into the previous row. After
// the object segment the pattern also swallows an all-zero 4-digit program
// placeholder before the project and an all-zero 4- or 7-digit placeholder
// after it (see the header comment). Only zeros are accepted there, and every
// digit run is bounded by (?!\d), so the tail can never bite into the next
// row's fund code. The second alternative catches codes mistyped on the sheet
// (1250.228990.514000.1003010, 122158.218700.539999, 40700.244600.5630001,
// 31630 210700 3840011002122): they won't resolve in the chart of accounts, but
// each still starts its own row, and it must never match from the middle of a
// longer number. Used both as the row anchor and on its own to extract the
// canonical code from a row's text.
const ACCOUNT_CODE_RE =
  /(?<![\d.])(?:(\d{5})[.\s-]*(\d{6})[.\s-]*(\d{5,6})(?!\d)|(\d{4,6})[.\s-]+(\d{6})[.\s-]+(\d{4,13})(?!\d))(?:[.\s-]+0{4}(?!\d))?(?:[.\s-]+(\d{7})(?!\d))?(?:[.\s-]+0{4,7}(?!\d))?/;

// Anchor for splitting the section into rows. Each match starts a new row;
// the row's full text runs from one match to the next (or end of section).
const ACCOUNT_CODE_ANCHOR_RE = new RegExp(ACCOUNT_CODE_RE.source, 'g');

// Within a single row's text, these patterns are matched independently so
// element ORDER doesn't matter (Tampa staff produce both
// "<code> FY26 $X (Type)" and "<code> $X FY2026 (Type)" formats).
const FY_RE = /\bFY\s*(?:20)?(\d{2})\b/i;
// The fraction takes up to three digits so "$836.100" (8/7/25 item 42, a typo
// for $836,100) is seen whole and repaired by parseDollarValue. The boundary
// keeps a project number run into the amount out of it: "$5,800,000.1002350"
// (5/7/26 item 111) is $5,800,000.
const MONEY_RE = /\$\s*(\d[\d,]*(?:\.\d{1,3}(?!\d))?)/g;
// "$4.0 million" is narrative, never a row amount.
const SCALE_AFTER_RE = /^\s*(?:million|billion)\b/i;
// "$200 p/ session", "$250-$300 p/ session" and "$31,000 per year" are rates,
// not totals.
const RATE_AFTER_RE = /^\s*(?:[-–]\s*\$?[\d,.]+\s*)?(?:p\/|per\b|\/\s*(?:yr|year|mo|month|session))/i;
// A few sheets omit the dollar sign: "(40,000)", "500,000 (Expenditure)". Only
// a comma-grouped number sitting directly after the account code counts, so a
// figure in the description can't be read as the amount.
const BARE_AMOUNT_AFTER_CODE_RE = /^[\s\-–:]*(?:FY\s*\d{2,4}\s*)?(\(?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)/i;
const MARKER_RE = /\(([^)]+)\)/g;
// A marker with no parens, directly after the amount: "$52,095.78 Expenditure Increase".
const BARE_MARKER_RE =
  /^[\s\-–,:]*((?:estimated\s+)?(?:(?:increase|decrease)\s+)?(?:revenue|expenditures?|expense)(?:\s+(?:increase|decrease|reduction))?|estimated\s+amount)\b/i;
// Words a parenthesized fund or project name can share with a type marker
// ("(Stormwater Revenue Bond Fund)").
const NOT_A_MARKER_RE = /\b(?:bonds?|funds?)\b/i;
// Sheets with no account code at all still name the money they're talking
// about this way; anything else ("$422,138,440 (FY2026)", a lone "$15,110.89",
// "$10,400,000 - TOTAL (estimated loan principal amount)") is a figure in
// passing, not a row.
const NO_CODE_KEYWORD_RE = /\bestimated\s+(?:expenditures?|amount)\b|\brequisition\b/i;
// Contract metadata lines repeat row amounts ("P: 1002890 O: TSS ... A: 100654
// $2,000,000"). Only stripped when splitting on amounts, where they'd read as
// new rows.
const METADATA_LINE_RE = /^.*(?:\bP\s*[:\-–]\s*\d{7}\b|\bT\s*[:\-–]\s*\d+\s+A\s*[:\-–]\s*\d+).*$/gm;
// Subject-to-appropriation: phrase may wrap across line breaks, so use
// \s+ between every word. "Contingent upon available funds" is the same
// promise in other words (11/5/26 item 55, FY28 and FY29 rows).
const SUBJECT_RE = /subject\s+to\s+annual\s+appropriation|contingent\s+upon\s+available\s+funds/i;

/**
 * Map a type marker to a normalized type and budget sign.
 *
 * Staff word the direction many ways ("Expenditure Decrease", "Decrease
 * Expenditure", "Expense reduction", "Revenue reduction"), so the kind of money
 * and the direction are read independently.
 *
 * Returned `signedDirection` describes how this row affects the City's
 * net cash position THIS fiscal year:
 *   +1  the City spends more (or loses revenue it was counting on)
 *   -1  the City spends less (or gains revenue)
 *    0  unrecognized — caller should treat as a parse error
 */
function classifyTypeMarker(marker) {
  const m = (marker || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const lowers = /\b(?:decreas|reduc)/.test(m);
  if (m.includes('revenue')) {
    return lowers
      ? { type: 'revenue_decrease', signedDirection: +1 }
      : { type: 'revenue', signedDirection: -1 };
  }
  if (m.includes('expenditure') || m.includes('expense') || m.includes('appropriation')) {
    return lowers
      ? { type: 'expenditure_decrease', signedDirection: -1 }
      : { type: 'expenditure', signedDirection: +1 };
  }
  if (m === 'decrease') {
    return { type: 'expenditure_decrease', signedDirection: -1 };
  }
  return { type: 'unknown', signedDirection: 0 };
}

const DIRECTION = { expenditure: +1, expenditure_decrease: -1, revenue: -1, revenue_decrease: +1, unknown: 0 };

/**
 * Parse a normalized dollar string ("330,665.99") into a number. A three-digit
 * fraction is a mistyped thousands separator ("836.100"); cents are two digits.
 */
function parseDollarValue(s) {
  const n = parseFloat(_repairDollarString(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function _repairDollarString(s) {
  return String(s).replace(/\$/g, '').replace(/^(\d{1,3})\.(\d{3})$/, '$1,$2');
}

/**
 * First money figure in `text`, skipping narrative "$X million". Returns null
 * when there is none or when the first one is a rate rather than a total.
 */
function _findMoney(text) {
  for (const m of text.matchAll(MONEY_RE)) {
    const after = text.slice(m.index + m[0].length);
    if (SCALE_AFTER_RE.test(after)) continue;
    if (RATE_AFTER_RE.test(after)) return null;
    const negative = /\(\s*$/.test(text.slice(0, m.index)) && /^\s*\)/.test(after);
    return { index: m.index, end: m.index + m[0].length, raw: m[1], negative };
  }
  return null;
}

function _findAmount(text, codeMatch) {
  const money = _findMoney(text);
  if (money || !codeMatch) return money;
  const start = codeMatch.index + codeMatch[0].length;
  const bare = BARE_AMOUNT_AFTER_CODE_RE.exec(text.slice(start));
  if (!bare) return null;
  return { index: start, end: start + bare[0].length, raw: bare[2], negative: bare[1] === '(' };
}

/**
 * Pick the type marker for a row: the first parenthesized group that actually
 * names a kind of money, else a bare marker right after the amount. A row can
 * carry other parentheticals ahead of the real one ("(FY27) - $225,000
 * (Expenditure)") or only unrelated ones ("(UASI)").
 */
function _findMarker(text, amount) {
  for (const m of text.matchAll(MARKER_RE)) {
    const inner = m[1].replace(/\s+/g, ' ').trim();
    if (NOT_A_MARKER_RE.test(inner)) continue;
    if (classifyTypeMarker(inner).type !== 'unknown') {
      return { text: inner, end: m.index + m[0].length };
    }
  }
  const bare = BARE_MARKER_RE.exec(text.slice(amount.end).replace(/^\s*\)/, ''));
  if (bare) {
    return { text: bare[1].replace(/\s+/g, ' ').trim(), end: amount.end + bare[0].length };
  }
  return null;
}

/**
 * Type a row. The marker decides when it can; otherwise the object code does,
 * since the chart of accounts numbers revenue in the 3xxxxx range and spending
 * in the 5xxxxx range. A parenthesized amount is the sheets' convention for a
 * decrease, and holds unless the marker explicitly says increase.
 */
function _classifyRow(markerText, objects, amount, text) {
  let { type } = classifyTypeMarker(markerText);
  if (type === 'unknown' && objects.length) {
    const kinds = new Set(objects.map((o) => o[0]));
    if (kinds.size === 1 && kinds.has('3')) type = 'revenue';
    if (kinds.size === 1 && kinds.has('5')) type = 'expenditure';
  }
  if (type === 'unknown' && !objects.length && NO_CODE_KEYWORD_RE.test(text)) {
    type = 'expenditure';
  }
  if (amount.negative && !/increase/i.test(markerText)) {
    if (type === 'expenditure') type = 'expenditure_decrease';
    if (type === 'revenue') type = 'revenue_decrease';
  }
  return type;
}

function _codeParts(codeMatch) {
  const fund = codeMatch[1] || codeMatch[4];
  const dept = codeMatch[2] || codeMatch[5];
  let obj = codeMatch[3] || codeMatch[6];
  let rawProject = codeMatch[7];
  // An object and project written with no separator.
  if (obj.length === 13) {
    rawProject = rawProject || obj.slice(6);
    obj = obj.slice(0, 6);
  }
  // An all-zero project ("0000000") is the sheet's way of writing "no
  // project"; the chart of accounts has no node for it (opengov/
  // parse_account_code.py drops it the same way).
  const project = rawProject && !/^0+$/.test(rawProject) ? rawProject : null;
  return {
    accountCode: [fund, dept, obj, project].filter(Boolean).join('.'),
    fund,
    department: dept,
    object: obj,
    project,
  };
}

/**
 * Build one row from a fragment of section text. `codeMatches` is every account
 * code in the fragment: one for a normal row, none when the sheet says
 * "Controlled by Requisition", several when one amount funds a list of codes
 * ("Funding of $81,546,855 (Expenditure)" followed by two codes). A row with
 * several codes has no single account, so accountCode stays null and the codes
 * move to pooledCodes.
 */
function _buildRow(text, codeMatches) {
  const single = codeMatches.length === 1 ? codeMatches[0] : null;
  const amount = _findAmount(text, single);
  if (!amount) return null;

  const marker = _findMarker(text, amount);
  const objects = codeMatches.map((c) => _codeParts(c).object);
  const markerText = marker ? marker.text : '';
  const type = _classifyRow(markerText, objects, amount, text);
  if (!codeMatches.length && type === 'unknown') return null;

  const fyMatch = FY_RE.exec(text);
  const subjectMatch = SUBJECT_RE.exec(text);
  const value = parseDollarValue(amount.raw);

  // Description = text AFTER the latest of {accountCode, amount, marker,
  // fy, subject} occurrences AND before the next row.
  const ends = [
    ...codeMatches.map((c) => c.index + c[0].length),
    amount.end,
    marker ? marker.end : 0,
    fyMatch ? fyMatch.index + fyMatch[0].length : 0,
    subjectMatch ? subjectMatch.index + subjectMatch[0].length : 0,
  ];
  const description = text
    .slice(Math.max(...ends))
    .replace(/^[\s,)]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const parts = single ? _codeParts(single) : {};
  const row = {
    accountCode: parts.accountCode || null,
    fund: parts.fund || null,
    department: parts.department || null,
    object: parts.object || null,
    project: parts.project || null,
    fiscalYear: fyMatch ? `FY${fyMatch[1]}` : null,
    amount: `$${_repairDollarString(amount.raw)}`,
    value,
    type,
    signedValue: value * DIRECTION[type],
    subjectToAppropriation: Boolean(subjectMatch),
    marker: markerText,
    description,
  };
  if (codeMatches.length > 1) {
    row.pooledCodes = codeMatches.map((c) => _codeParts(c).accountCode);
  }
  return row;
}

function _matchAllCodes(text) {
  return [...text.matchAll(ACCOUNT_CODE_ANCHOR_RE)];
}

/**
 * The usual layout: each account code starts a row, and the row's text runs to
 * the next code. Description text following the account row (e.g. "General
 * Fund. Fire Dept.") is included with that row but stripped before storing.
 */
function _parseCodeFirstRows(sectionText) {
  const codes = _matchAllCodes(sectionText);
  const rows = [];
  for (let i = 0; i < codes.length; i++) {
    const end = i + 1 < codes.length ? codes[i + 1].index : sectionText.length;
    const text = sectionText.slice(codes[i].index, end);
    const row = _buildRow(text, _matchAllCodes(text));
    if (row) {
      rows.push(row);
    } else if (process.env.PROJECTED_COSTS_DEBUG) {
      console.warn('[projected-costs-parser] dropping unparseable row:', JSON.stringify(text.slice(0, 200)));
    }
  }
  return rows;
}

/**
 * The other layout: the amount comes first, or there are no codes at all.
 *   $28,583 01100.228990.546000 FY26 (Expenditure)
 *   Fiscal Impact: $55,072.00 (Expenditure Increase) Account: 62200.243000.560005.1001518
 *   Controlled by Requisition FY2026 $632,000 Estimated Amount
 *   FY2026 Funding of $12,675,000 will be provided: <three codes>
 * Each amount starts a row, beginning at the start of its line so a leading FY
 * tag stays with it. Splitting on codes here would hand each code the next
 * row's amount. A code-less line that is the sum of the coded rows under it
 * is a heading, not another row ("($4,955,424.50) Expenditure" above its
 * $2,700,000 and $2,255,424.50 rows, 7/31/25 item 71).
 */
function _parseAmountFirstRows(sectionText) {
  const text = sectionText.replace(METADATA_LINE_RE, '');
  const starts = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const after = text.slice(m.index + m[0].length);
    if (SCALE_AFTER_RE.test(after) || RATE_AFTER_RE.test(after)) continue;
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const prev = starts[starts.length - 1];
    starts.push(prev !== undefined && prev >= lineStart ? m.index : lineStart);
  }
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length);
    const row = _buildRow(chunk, _matchAllCodes(chunk));
    if (row) rows.push(row);
  }
  const codedSum = rows.filter((r) => r.accountCode).reduce((sum, r) => sum + r.value, 0);
  return rows.filter((r) => r.accountCode || r.pooledCodes || Math.abs(r.value - codedSum) > 1);
}

/**
 * Extract structured rows from the PROJECTED COSTS section.
 *
 * Returns an array of:
 *   {
 *     accountCode: "01100.215000.552003.1002686" | "01100.215000.552003" | null,
 *     fund, department, object, project: string | null,
 *     fiscalYear: "FY26" | null,
 *     amount: "$330,665.99",
 *     value: 330665.99,
 *     type: "expenditure" | "expenditure_decrease" | "revenue" | "revenue_decrease" | "unknown",
 *     signedValue: number,
 *     subjectToAppropriation: boolean,
 *     marker: string,                 // '' when the type came from the object code
 *     description: string,
 *     pooledCodes?: string[]          // one amount funding several codes
 *   }
 *
 * accountCode is null for "Controlled by Requisition" rows and pooled rows.
 * Rows with no total (no dollar amount, "Amount to be determined", a rate) are
 * dropped so they don't quietly produce $0 or per-unit entries downstream.
 */
function parseProjectedCostsRows(sectionText) {
  if (!sectionText) return [];
  const firstCode = ACCOUNT_CODE_RE.exec(sectionText);
  const firstMoney = _findMoney(sectionText);
  const amountFirst = firstMoney && (!firstCode || firstMoney.index < firstCode.index);
  return amountFirst ? _parseAmountFirstRows(sectionText) : _parseCodeFirstRows(sectionText);
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

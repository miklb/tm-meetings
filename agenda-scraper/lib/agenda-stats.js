/**
 * Agenda Stats
 *
 * The counts and dollar figures behind an agenda's intro: "a 95 item agenda, 80
 * requiring a vote; $37 million in spending ranging from $2,000 to $17.4 million,
 * plus $43 million in reallocations." Everything here is deterministic; prose
 * is written from this output and never does its own math.
 *
 * Dollars come from the PROJECTED COSTS rows, re-parsed from the stored raw text
 * so a parser fix applies without a backfill. Each figure is then checked against
 * what staff wrote in the title and FISCAL IMPACT STATEMENT. The two are
 * independent paths to the same number.
 *
 * When they disagree nothing here picks a winner. The item is flagged with what
 * each source says and stays out of every total and the range. spending.atLeast
 * adds the lowest figure each flagged item could come to, so "over $18 million"
 * holds however the flags are settled.
 *
 * What the buckets mean:
 *   spending      New money a vote authorizes: contracts, renewals, grant-funded
 *                 budget amendments. All fiscal years, including "subject to annual
 *                 appropriation" years, the way the contract total reads in the
 *                 title. Close-outs count at the final payment only.
 *   reallocation  Budget amendments ("making certain changes in the budget") that
 *                 also take money out of a line. Counted at the title's figure.
 *   revenue       Money coming in with nothing spent on it: liens, fees, a grant
 *                 accepted with no appropriation attached.
 *   debt          Reimbursement resolutions and bond authorizations. Not an
 *                 appropriation, and often larger than the rest of the agenda put
 *                 together, so kept out of the total.
 *   annualBudget  Adoption of an annual budget.
 *   mentioned     A dollar figure in a title with nothing behind it on the sheet: a
 *                 horse "valued at $7,000", a hearing being set. Listed, not counted.
 *
 * Linked items ("(Part 1 of 2)(See Item 48)") usually carry the same dollars
 * twice, once to approve the agreement and once to appropriate it. A linked group
 * counts once, at its largest figure.
 */

const { parseProjectedCostsRows } = require('./projected-costs-parser');

// Close enough to call two dollar figures the same. Sheets round to the dollar
// in places (10/23/25 item 40: rows sum to $4,468,842, the title says $4,468,840).
const AGREE_WITHIN = 2;

// Nominal consideration ("for the sum of $1") isn't a real low end of a range.
const NOMINAL = 1;

const LEGISLATIVE_RE = /\b(?:resolution|ordinance)\b/i;
const CEREMONIAL_SECTION_RE = /COMMENDATION|CEREMONIAL|PRESENTATION/i;
const NO_VOTE_SECTION_RE = /WRITTEN STAFF REPORTS|CLOSED SESSION/i;
const STAFF_REPORT_SECTION_RE = /STAFF REPORTS/i;

const BUDGET_AMENDMENT_RE = /making certain changes in the budget|transfer, reallocation,? and\/or appropriation/i;
const ANNUAL_BUDGET_RE = /\badopt\w*\b[^.]*\bbudget\b/i;
const DEBT_RE = /\b(?:issuance|issue|sale)\b[^.]*\bbonds?\b|\bbonds?\b[^.]*\b(?:issuance|validation)\b|\bvalidation of\b[^.]*\bdebt\b|\brelating to\b[^.;]*\bState Revolving Fund\b/i;
// Looked for in the fiscal statement too, where 9/3/26 item 39 says it. DEBT_RE
// isn't, since a statement can say a contract is paid for by a bond issue.
const REIMBURSEMENT_RE = /\breimbursement resolution\b|\breimburse itself\b/i;
const CLOSEOUT_RE = /\bchange order\s+\d+\s+final\b|\bfinal (?:payment|change order)\b|\bclose[- ]?out\b/i;
const AMOUNT_TBD_RE = /\b(?:amount\s+(?:to\s+be\s+determined|tbd)|to\s+be\s+determined\s+based)\b/i;
const NON_CASH_RE = /\bwill not receive any funds\b|\bno (?:financial|fiscal) (?:impact|obligation)\b|\bimpact fee credit\b/i;
const VENDOR_SERVICES_RE = /\b(?:consultant|professional|construction|engineering|design-build)\s+services\b/i;
const GRANT_TITLE_RE = /\b(?:grant|donation|subrecipient)\b/i;

// "\)?" for "twenty ($20) million" (3/5/26 item 68).
const STATED_MONEY_RE = /\$\s*(\d[\d,]*(?:\.\d+)?)\)?(\s*(?:million|billion)\b)?/gi;
// The figure a title is really about, when it names more than one.
const TITLE_FIGURE_RE =
  /(?:appropriation of|(?:amount|sum|total|price|cost|value) of|not (?:to )?exceed(?:ing)?|adding)\s+\$\s*(\d[\d,]*(?:\.\d+)?)(\s*(?:million|billion)\b)?/gi;

const round2 = (n) => Math.round(n * 100) / 100;
const agree = (a, b) => Math.abs(a - b) <= AGREE_WITHIN;
const dollars = (n) => `$${n.toLocaleString('en-US')}`;

function _toNumber(digits, scale) {
  const n = parseFloat(String(digits).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (!scale) return n;
  return /billion/i.test(scale) ? n * 1e9 : n * 1e6;
}

/** Every positive dollar figure in a piece of text. "$80 million" is 80000000. */
function statedAmounts(text) {
  const out = [];
  for (const m of String(text || '').matchAll(STATED_MONEY_RE)) {
    const n = _toNumber(m[1], m[2]);
    if (n > 0) out.push(n);
  }
  return out;
}

function _titleFigures(title) {
  const out = [];
  for (const m of String(title || '').matchAll(TITLE_FIGURE_RE)) {
    const n = _toNumber(m[1], m[2]);
    if (n > 0) out.push(n);
  }
  return out;
}

/**
 * Whether an item takes a vote. Commendations, written reports and closed
 * sessions don't. Under Staff Reports only resolutions and ordinances do; the
 * rest are "staff to appear and report". Older scrapes have no section, so the
 * title is all there is to go on.
 *
 * Checked against 7 agendas where Michael counted by hand: exact on 2, within 3
 * on the other 5. The misses go both ways and the excluded items are listed in
 * the report, so an agenda-specific call is easy to make.
 */
function requiresVote(item) {
  const section = String(item.section || '');
  const legislative = LEGISLATIVE_RE.test(item.title || '');
  if (!section) return legislative;
  if (CEREMONIAL_SECTION_RE.test(section) || NO_VOTE_SECTION_RE.test(section)) return false;
  if (STAFF_REPORT_SECTION_RE.test(section)) return legislative;
  return true;
}

// Inter-fund transfers: 591xxx out of the sending fund, 381xxx into the receiving
// one. Same dollars twice, so they don't count (render-funding.js does the same).
const isTransfer = (row) => /^(?:591|381)/.test(row.object || '');

const sumType = (rows, type) => rows.filter((r) => r.type === type).reduce((s, r) => s + r.value, 0);

/**
 * Classify one agenda item and work out its figure.
 * Returns { number, fileNumber, kind, amount, source, closeout, check, notes }.
 *   kind    'spending' | 'reallocation' | 'revenue' | 'debt' | 'annualBudget' | 'none'
 *   source  'rows' | 'title'
 *   check   'verified' | 'unchecked' (staff stated no figure) | 'review'
 * A 'review' item has no agreed figure: `figures` is what the sources say, `low`
 * the least it could come to, and `amount` only what it's compared on when linked
 * parts are counted once. It reaches no total.
 */
function summarizeItem(item) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  const pc = item.projectedCosts || {};
  const raw = pc.projectedCostsRaw || '';
  const fis = pc.fiscalImpactStatement || '';
  const rows = parseProjectedCostsRows(raw);
  const program = rows.filter((r) => !isTransfer(r));

  const spending = round2(sumType(program, 'expenditure'));
  const decreases = round2(sumType(program, 'expenditure_decrease'));
  const revenue = round2(sumType(program, 'revenue'));
  const unknown = round2(sumType(program, 'unknown'));

  const titleAmounts = statedAmounts(title);
  const fisAmounts = statedAmounts(fis);
  const stated = [...titleAmounts, ...fisAmounts];
  const titleFigures = _titleFigures(title);
  const headline = titleFigures.length ? Math.max(...titleFigures) : null;

  const base = {
    number: item.number,
    agendaItemId: item.agendaItemId,
    fileNumber: item.fileNumber || null,
    title,
    section: item.section || null,
    spending,
    decreases,
    revenue,
    closeout: CLOSEOUT_RE.test(title),
    amountTbd: AMOUNT_TBD_RE.test(raw),
    notes: [],
  };
  const done = (kind, amount, source, check) => ({ ...base, kind, amount: round2(amount), source, check: unknown > 0 ? 'review' : check });
  const flagged = (kind, amount, source, figures, low) => ({ ...done(kind, amount, source, 'review'), figures, low: round2(low) });
  const fallback = headline ?? (titleAmounts.length ? Math.max(...titleAmounts) : 0);

  if (unknown > 0) {
    base.notes.push(`${dollars(unknown)} in rows with no recognizable type`);
  }

  // Debt and budgets are rarely itemized on the sheet, so the figure is what staff
  // wrote. With none in the title and several in the statement there's no telling
  // which it is (11/5/26 item 49: $20 million, $20,400,000, $10,000,000).
  const statedFigure = (kind) => {
    const distinct = [...new Set(fisAmounts)];
    if (fallback || distinct.length < 2) return done(kind, fallback || Math.max(0, ...stated), 'title', 'verified');
    base.notes.push(`the title names no figure; staff state ${distinct.slice(0, 4).map(dollars).join(', ')}`);
    return flagged(kind, Math.max(...distinct), 'title', distinct, Math.min(...distinct));
  };
  if ((DEBT_RE.test(title) || REIMBURSEMENT_RE.test(`${title} ${fis}`)) && !BUDGET_AMENDMENT_RE.test(title)) {
    return statedFigure('debt');
  }
  if (ANNUAL_BUDGET_RE.test(title) && !BUDGET_AMENDMENT_RE.test(title)) {
    return statedFigure('annualBudget');
  }

  if (BUDGET_AMENDMENT_RE.test(title) && decreases > 0) {
    // The title's figure is what's being moved; the rows carry both sides of
    // the move in amounts that rarely add up to it on their own.
    if (headline) return done('reallocation', headline, 'title', 'verified');
    return done('reallocation', Math.max(spending, decreases), 'rows', 'unchecked');
  }

  if (spending > 0) return _checkedSpending(base, done, flagged, spending, stated, titleAmounts, fisAmounts);

  // Only a decrease: a close-out returning money, with nothing new approved.
  if (decreases > 0) {
    base.notes.push(`returns ${dollars(decreases)}; nothing new approved`);
    return done('none', 0, 'rows', 'verified');
  }

  if (revenue > 0) {
    // Almost always the sheet is right and the City is the one being paid, even
    // under a title that says "agreement". The exception is a vendor's services,
    // where the sheet shows where the money comes from and leaves out where it
    // goes (11/5/26 item 46). That can't be told apart reliably, so it stays out
    // of the total and goes to a person.
    if (headline && VENDOR_SERVICES_RE.test(title)) {
      base.notes.push(`title reads as ${dollars(headline)} paid to a vendor, but the sheet lists only revenue`);
      return { ...flagged('revenue', revenue, 'rows', [headline], 0), grant: false };
    }
    const check = stated.some((s) => agree(s, revenue)) ? 'verified' : 'unchecked';
    return { ...done('revenue', revenue, 'rows', check), grant: GRANT_TITLE_RE.test(title) };
  }

  // A section with no usable rows. A figure in the title may still be the amount
  // being voted on (codes listed with no amounts, 7/16/26 item 79), so it's flagged
  // and a $15 million contract can't vanish from a total unnoticed.
  if (raw && headline && !base.amountTbd && !NON_CASH_RE.test(`${raw} ${fis}`)) {
    if (GRANT_TITLE_RE.test(title)) {
      base.notes.push(`no amounts in PROJECTED COSTS; title names ${dollars(headline)} coming in`);
      return { ...flagged('revenue', headline, 'title', [headline], 0), grant: true };
    }
    base.notes.push(`no amounts in PROJECTED COSTS; title says ${dollars(headline)}`);
    return flagged('spending', headline, 'title', [headline], 0);
  }

  // No section at all, or nothing that reads as cash, with a figure in the title:
  // a donation "valued at $13,000", a hearing being set. Not spending, and not
  // an error, but sometimes the most interesting number on the agenda.
  if (headline) return { ...done('none', 0, 'title', 'verified'), mentioned: headline };
  return done('none', 0, 'rows', base.amountTbd ? 'unchecked' : 'verified');
}

function _checkedSpending(base, done, flagged, spending, stated, titleAmounts, fisAmounts) {
  if (!stated.length) return done('spending', spending, 'rows', 'unchecked');
  if (stated.some((s) => agree(s, spending))) return done('spending', spending, 'rows', 'verified');
  // Staff itemize in prose ("$781,022.21 ... and $881,210.88"), so the rows can
  // match the parts added up (11/5/26 items 41 and 47).
  const addsUp = (figures) => figures.length > 1 && agree(figures.reduce((s, n) => s + n, 0), spending);
  if (addsUp([...new Set(titleAmounts)]) || addsUp([...new Set(fisAmounts)])) {
    return done('spending', spending, 'rows', 'verified');
  }

  // Rows and staff's figures disagree, and either could be the wrong one: a title
  // can quote an annual price or a running total, and a sheet can carry a typo
  // ("$2,666,700,000" for $2,666,700, 7/31/25 item 70).
  const largest = Math.max(...(titleAmounts.length ? titleAmounts : stated));
  base.notes.push(`rows total ${dollars(spending)}; staff state ${[...new Set(stated)].slice(0, 4).map(dollars).join(', ')}`);
  return flagged('spending', spending, 'rows', [spending, largest], Math.min(spending, ...stated));
}

/**
 * Sets of item numbers joined by "(See Item 48)" / "(See Items 36, 37, & 39)".
 * Only references to items that exist on this agenda count; a typo'd cross
 * reference ("(See Item )", 7/31/25) links nothing.
 */
function linkedGroups(items) {
  const parent = new Map(items.map((i) => [String(i.number), String(i.number)]));
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  for (const item of items) {
    const m = /\(\s*See\s+Items?\s*([^)]*)\)/i.exec(String(item.title || ''));
    if (!m) continue;
    for (const ref of m[1].match(/\d+/g) || []) {
      if (parent.has(ref)) parent.set(find(ref), find(String(item.number)));
    }
  }
  const groups = new Map();
  for (const item of items) {
    const root = find(String(item.number));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(String(item.number));
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function _dedupeLinked(summaries, groups) {
  const byNumber = new Map(summaries.map((s) => [String(s.number), s]));
  const collapsed = [];
  for (const numbers of groups) {
    // Debt and annual budgets keep their own bucket; the linked items are the
    // ones carrying the same appropriation.
    const members = numbers.map((n) => byNumber.get(n)).filter((s) => s.amount > 0 && ['spending', 'reallocation', 'revenue'].includes(s.kind));
    if (members.length < 2) continue;
    const rank = { spending: 2, reallocation: 1, revenue: 0 };
    // On a tie the part that reconciles speaks for the group, so a part with no
    // amounts of its own isn't flagged when its twin carries them.
    const isFlagged = (m) => (m.check === 'review' ? 1 : 0);
    const best = [...members].sort((a, b) => b.amount - a.amount || isFlagged(a) - isFlagged(b) || rank[b.kind] - rank[a.kind])[0];
    const kind = members.map((m) => m.kind).sort((a, b) => rank[b] - rank[a])[0];
    for (const m of members) {
      if (m === best) {
        m.kind = kind;
        m.linkedWith = members.filter((o) => o !== m).map((o) => o.number);
      } else {
        m.countedWith = best.number;
      }
    }
    collapsed.push({ items: members.map((m) => m.number), countedAs: best.number, amount: best.amount, kind });
  }
  return collapsed;
}

function _bucket(summaries, kind) {
  const items = summaries.filter((s) => s.kind === kind && s.amount > 0 && s.countedWith === undefined && s.check !== 'review');
  return { total: round2(items.reduce((s, i) => s + i.amount, 0)), count: items.length, items };
}

/** Full stats for one scraped meeting. See the header comment for the buckets. */
function computeAgendaStats(meeting) {
  const items = meeting.agendaItems || [];
  const summaries = items.map(summarizeItem);
  const linked = _dedupeLinked(summaries, linkedGroups(items));

  const votes = items.filter(requiresVote);
  const noVote = items.filter((i) => !requiresVote(i));

  const review = summaries.filter((s) => s.check === 'review' && s.countedWith === undefined);
  // What could still change the spending total: flagged spending, and a vendor
  // contract whose sheet lists only revenue. A flagged grant is revenue either way.
  const openOnTotal = review.filter((r) => r.kind === 'spending' || (r.kind === 'revenue' && !r.grant));
  const spending = _bucket(summaries, 'spending');
  spending.flagged = openOnTotal.map((r) => r.number);
  spending.atLeast = round2(spending.total + openOnTotal.reduce((sum, r) => sum + (r.low ?? r.amount), 0));

  const reallocation = _bucket(summaries, 'reallocation');
  const revenue = _bucket(summaries, 'revenue');
  // The published range runs from "accepting a $2,000 donation" up through the
  // largest contract, so grants and donations count toward it but not the total.
  const ranged = [...spending.items, ...revenue.items.filter((i) => i.grant)]
    .filter((i) => i.amount > NOMINAL)
    .sort((a, b) => a.amount - b.amount);
  const smallest = ranged[0] || null;
  const largest = ranged[ranged.length - 1] || null;
  // A flagged figure past either end means that end may not be the real one.
  const pastAnEnd = (f) => f > NOMINAL && (!smallest || f < smallest.amount || f > largest.amount);
  const unsettled = review.filter((r) => ['spending', 'revenue'].includes(r.kind) && (r.figures || []).some(pastAnEnd));

  return {
    meetingId: meeting.meetingId,
    date: meeting.formattedDate,
    meetingName: meeting.meetingName || null,
    meetingType: meeting.meetingType || null,
    hasProjectedCosts: items.some((i) => i.projectedCosts),
    itemCount: items.length,
    voteCount: votes.length,
    noVoteItems: noVote.map((i) => ({ number: i.number, title: String(i.title || '').replace(/\s+/g, ' ').trim() })),
    spending,
    range: { smallest, largest, unsettled: unsettled.map((r) => r.number) },
    reallocation,
    revenue,
    debt: _bucket(summaries, 'debt'),
    annualBudget: _bucket(summaries, 'annualBudget'),
    linked,
    mentioned: summaries.filter((s) => s.mentioned > NOMINAL),
    amountTbd: summaries.filter((s) => s.amountTbd).map((s) => s.number),
    review,
    unchecked: summaries.filter((s) => s.check === 'unchecked' && s.amount > 0 && s.countedWith === undefined),
  };
}

module.exports = { computeAgendaStats, summarizeItem, requiresVote, linkedGroups, statedAmounts };

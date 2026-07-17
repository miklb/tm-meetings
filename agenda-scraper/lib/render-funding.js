/**
 * Render OpenGov funding data as WordPress block markup.
 *
 * Two surfaces:
 *   1. renderAgendaFundingOverview(manifest) — single block at top of agenda
 *   2. renderItemFinancialSection(fundingItem) — section nested inside each
 *      agenda item's "Item details" <details> drawer (no <details> wrapper of
 *      its own; the caller composes the drawer).
 *
 * Source of truth: the funding manifest produced by `opengov/reconcile.py`
 * from the structured PROJECTED COSTS rows extracted by
 * `lib/projected-costs-parser.js`. There is no parsing of dollar amounts
 * outside the PROJECTED COSTS table, so every figure shown here is a real
 * budget action this resolution effects — never a duplicate of a contract
 * total cited in narrative prose.
 *
 * Multi-fiscal-year handling: rows tagged `subjectToAppropriation: true`
 * (Council is not committing the dollars today; future Council decides) are
 * shown SEPARATELY from the headline budget impact. The headline reflects
 * only the current-FY commitment.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_DIR = path.join(__dirname, '..', '..', 'opengov', 'data', 'reports');

// ------------------------------------------------------------------
// Loading
// ------------------------------------------------------------------
function loadFundingManifest(meetingId, formattedDate) {
    if (!meetingId || !formattedDate) return null;
    const file = path.join(MANIFEST_DIR, `${meetingId}-${formattedDate}-funding-manifest.json`);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.error(`Failed to parse funding manifest ${file}:`, err.message);
        return null;
    }
}

function buildFundingByItemId(manifest) {
    const map = {};
    if (!manifest || !Array.isArray(manifest.items)) return map;
    for (const item of manifest.items) {
        if (item.agendaItemId) map[String(item.agendaItemId)] = item;
    }
    return map;
}

// ------------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------------
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatMoney(value, { sign = false, compact = false } = {}) {
    if (value == null || isNaN(value)) return '—';
    const abs = Math.abs(value);
    let s;
    if (compact && abs >= 1_000_000) {
        s = `$${(abs / 1_000_000).toFixed(1)}M`;
    } else if (compact && abs >= 10_000) {
        s = `$${Math.round(abs / 1_000)}K`;
    } else {
        s = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }
    if (sign) return (value >= 0 ? '+' : '−') + s;
    return value < 0 ? '−' + s : s;
}

function netClass(net) {
    return net > 0 ? 'is-positive' : net < 0 ? 'is-negative' : 'is-zero';
}

function itemHasResolvedFunding(fundingItem) {
    if (!fundingItem || !Array.isArray(fundingItem.rows)) return false;
    return fundingItem.rows.some(r => r.accountCode);
}

function itemHasFinancialData(fundingItem) {
    return itemHasResolvedFunding(fundingItem);
}

// ------------------------------------------------------------------
// Per-item financial section (lives inside the Item details drawer)
// ------------------------------------------------------------------

/**
 * Wrap a plain HTML section for the requested emitter dialect.
 * The WP emitter needs wp:html block comments; the markdown emitter takes
 * the section verbatim.
 */
function wrapSection(html, { wpWrap = true } = {}) {
    if (!wpWrap) return html;
    return `<!-- wp:html -->\n${html}\n<!-- /wp:html -->`;
}

/**
 * Fallback render when projected costs exist but no account codes resolved
 * (e.g. "Controlled by Requisition" items with no CoA match).
 */
function renderRawProjectedCosts(rawCosts, options = {}) {
    if (!rawCosts || !rawCosts.hasProjectedCosts) return '';

    const fisHtml = rawCosts.fiscalImpactStatement
        ? `<p class="agenda-item-financial__statement">${escapeHtml(rawCosts.fiscalImpactStatement)}</p>`
        : '';

    const rawLines = (rawCosts.projectedCostsRaw || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    const rawHtml = rawLines.length
        ? `<ul class="agenda-item-financial__sources">${rawLines.map(l =>
            `<li class="agenda-item-financial__source">${escapeHtml(l)}</li>`).join('')}</ul>`
        : '';

    if (!fisHtml && !rawHtml) return '';

    return wrapSection(`<section class="agenda-item-financial" aria-label="Financial impact">
<h4 class="agenda-item-section__heading">Financial impact</h4>
${fisHtml}
${rawHtml}
</section>`, options);
}

function renderItemFinancialSection(fundingItem, rawProjectedCosts, options = {}) {
    if (!itemHasResolvedFunding(fundingItem)) return renderRawProjectedCosts(rawProjectedCosts, options);

    const totals = fundingItem.totals || {};
    const committed = totals.committed || {};
    const future = totals.future || {};
    const headlineFy = totals.headlineFiscalYear || null;

    // FISCAL IMPACT STATEMENT verbatim — the human-language summary the
    // City staff wrote. Often clearer than any totals strip we can build.
    const fisHtml = fundingItem.fiscalImpactStatement
        ? `<p class="agenda-item-financial__statement">${escapeHtml(fundingItem.fiscalImpactStatement)}</p>`
        : '';

    // Plain gross totals — answering "how much is being authorized?", not
    // "what is the net change to the City budget?". A layperson reading a
    // grant acceptance does not want to see "−$X" because the City offsets
    // future spending with that revenue. Show each direction independently.
    //
    // Inter-fund transfer rows are excluded from headline totals to prevent
    // double-counting on multi-fund resolutions. Tampa uses:
    //   591xxx — transfer-out expenditure (sending fund)
    //   381xxx — transfer-in revenue (receiving fund)
    // Both sides of the same money appear in the same resolution, so summing
    // them produces a number roughly 2× the real programmatic spending.
    // The rows still appear in the Funding sources list for full transparency.
    const fyTag = headlineFy ? ` (${headlineFy})` : '';
    const _isTransfer = row => {
        const obj = (row.accountCode || '').split('.')[2] || '';
        return obj.startsWith('591') || obj.startsWith('381');
    };
    const allCommittedRows = (fundingItem.rows || []).filter(r => !r.subjectToAppropriation);
    const programRows = allCommittedRows.filter(r => !_isTransfer(r));
    const sumType = type => programRows.filter(r => r.type === type).reduce((s, r) => s + (r.value || 0), 0);
    // Fall back to pre-computed manifest totals when row-level data is absent.
    const hasRows = allCommittedRows.length > 0;
    const effExpenditures     = hasRows ? sumType('expenditure')         : (committed.expenditures || 0);
    const effRevenues         = hasRows ? sumType('revenue')             : (committed.revenues || 0);
    const effDecreases        = hasRows ? sumType('expenditure_decrease') : (committed.decreases || 0);
    const effRevenueDecreases = hasRows ? sumType('revenue_decrease')    : (committed.revenueDecreases || 0);

    // Suppress totals strip when the item is a pure "grant in = grant out"
    // pair — exactly one revenue row and one expenditure row of equal value,
    // no other programmatic rows. This is the Part 1 of 2 pattern: the legal
    // agreement that approves accepting the grant. The budget amendment (Part
    // 2) appropriates the same dollars again alongside other changes, so
    // showing a totals strip here would double-count across the two items.
    // The FIS statement and funding sources rows remain visible.
    const revRows  = programRows.filter(r => r.type === 'revenue');
    const expRows  = programRows.filter(r => r.type === 'expenditure');
    const isPureGrantPair =
        programRows.length === 2 &&
        revRows.length === 1 && expRows.length === 1 &&
        revRows[0].value === expRows[0].value;

    // Reallocation: the resolution moves money between line items rather than
    // authorizing new net spending. When a reallocation block is present we
    // replace "Spending authorized" with a "Reallocated" headline that shows
    // the larger side (matches the dollar figure in the resolution title).
    const reallocation = fundingItem.reallocation || null;
    const isReallocation = reallocation !== null && !isPureGrantPair;

    const totalRows = isPureGrantPair ? [] : isReallocation ? [
        ['Reallocated', Math.max(reallocation.decreasesTotal, reallocation.increasesTotal),
            'Funds moved between accounts within the same fund or department; not net new spending.'],
        ['Grant or revenue accepted', effRevenues,
            'Outside funds (grants, fees, reimbursements) the City is committing to receive in the current fiscal year.'],
        ['Revenue reduced', effRevenueDecreases,
            'Outside funds the City was expecting but will no longer receive (e.g. a grant amendment).'],
    ] : [
        ['Spending authorized', effExpenditures,
            'Total dollars this resolution authorizes the City to spend in the current fiscal year. Inter-fund transfers are excluded to avoid double-counting.'],
        ['Grant or revenue accepted', effRevenues,
            'Outside funds (grants, fees, reimbursements) the City is committing to receive in the current fiscal year.'],
        ['Revenue reduced', effRevenueDecreases,
            'Outside funds the City was expecting but will no longer receive (e.g. a grant amendment).'],
        ['Spending reduced', effDecreases,
            'Previously authorized spending this resolution removes from the budget.'],
    ];
    const totalsHtml = totalRows
        .filter(([, v]) => v && v !== 0)
        .map(([label, value, hint]) => {
            const titleAttr = hint ? ` title="${escapeHtml(hint)}"` : '';
            return `<div class="agenda-item-financial__row"${titleAttr}><dt>${escapeHtml(label + fyTag)}</dt><dd>${escapeHtml(formatMoney(value))}</dd></div>`;
        })
        .join('');

    // Future-year line — only when there are appropriations subject to
    // annual approval.
    const futureGross =
        (future.expenditures || 0) +
        (future.decreases || 0) +
        (future.revenues || 0) +
        (future.revenueDecreases || 0);
    const futureHtml = futureGross
        ? `<p class="agenda-item-financial__future">Plus <strong>${escapeHtml(formatMoney(futureGross))}</strong> in future-year amounts subject to annual Council approval.</p>`
        : '';

    // Funding sources — one <li> per PROJECTED COSTS row.
    const sourceItems = (fundingItem.rows || []).map(row => {
        const e = row.enriched || {};
        // When enriched CoA data is absent, fall back to the raw description
        // string (dot-separated segments from the staff report PDF).
        // Strip trailing project-metadata annotations like
        // "P: 1002953 O: P&R … T: 30 Contract: 100255".
        let descSegs = [];
        if (row.description) {
            const clean = row.description
                .replace(/\bP:\s*\d+.*$/s, '')   // strip project metadata
                .trim();
            descSegs = clean.split('.').map(s => s.trim()).filter(Boolean);
        }
        const fund    = (e.fund    && e.fund.name)          || descSegs[0] || null;
        const dept    = (e.department && e.department.name) || descSegs[1] || null;
        const obj     = (e.object  && e.object.name)        || descSegs[2] || null;
        // Use CoA project name if available; otherwise fall back to 4th
        // description segment (e.g. "Palma Ceia Lions Park Improvements").
        const project = (e.project && e.project.name)       || descSegs[3] || null;
        const typeCls = row.type ? `is-${row.type.replace(/_/g, '-')}` : '';
        const subjectCls = row.subjectToAppropriation ? 'is-future' : '';
        const fy = row.fiscalYear || '';
        const meta = [fy, row.accountCode].filter(Boolean).join(' · ');
        const amount = row.amount || formatMoney(row.value);

        const labelLines = [];
        if (fund) labelLines.push(`<span class="agenda-item-financial__fund">${escapeHtml(fund)}</span>`);
        if (dept) labelLines.push(`<span class="agenda-item-financial__dept">${escapeHtml(dept)}</span>`);
        if (obj) labelLines.push(`<span class="agenda-item-financial__object">${escapeHtml(obj)}</span>`);
        if (project) labelLines.push(`<span class="agenda-item-financial__project">${escapeHtml(project)}</span>`);

        const markerLabel = (row.marker || row.type || '').replace(/_/g, ' ');
        const markerSpan = markerLabel
            ? `<span class="agenda-item-financial__marker">${escapeHtml(markerLabel)}</span>`
            : '';
        const subjectTag = row.subjectToAppropriation
            ? `<span class="agenda-item-financial__subject" title="Council is not committing this fiscal year today; subject to future-year appropriation.">subject to annual appropriation</span>`
            : '';

        return (
            `<li class="agenda-item-financial__source ${typeCls} ${subjectCls}">` +
                `<span class="agenda-item-financial__amount">${escapeHtml(amount)}</span>` +
                labelLines.join('') +
                `<span class="agenda-item-financial__meta">${escapeHtml(meta)}</span>` +
                markerSpan +
                subjectTag +
            `</li>`
        );
    });
    const sourcesHtml = sourceItems.length
        ? `<h5 class="agenda-item-financial__sources-heading">Funding sources</h5>
<ul class="agenda-item-financial__sources">${sourceItems.join('')}</ul>`
        : '';

    // Genuinely unknown segments only. Project-only missing (1002xxx FY26 IDs
    // not yet in the public CoA) is informational, not an error: dollars are
    // attributed to fund/dept/object correctly.
    let trulyUnknown = 0;
    for (const r of fundingItem.rows || []) {
        const segs = r.unresolved || [];
        if (!segs.length) continue;
        const e = r.enriched || {};
        if (e.fund && e.department && e.object && !e.project) continue;
        trulyUnknown += 1;
    }
    const coaWarningHtml = trulyUnknown
        ? `<p class="agenda-item-financial__warning" role="note">${trulyUnknown} account code${trulyUnknown === 1 ? '' : 's'} could not be matched to the City's chart of accounts.</p>`
        : '';

    // Reallocation imbalance warning — surfaces a clerical discrepancy on the
    // city's Summary Sheet where the decrease and increase sides don't match.
    let imbalanceWarningHtml = '';
    if (isReallocation && reallocation && !reallocation.balanced) {
        const imb = formatMoney(Math.abs(reallocation.imbalance));
        // Link to the cover-sheet PDF if available via supporting documents.
        const coverSheet = (fundingItem.supportingDocuments || []).find(
            d => /cover\s*sheet/i.test(d.title || '')
        );
        const pdfUrl = (coverSheet && coverSheet.mirroredUrl) || null;
        const pdfLink = pdfUrl
            ? ` <a href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener noreferrer">Review the source PDF.</a>`
            : ' Review the source PDF for clarification.';
        imbalanceWarningHtml = `<p class="agenda-item-financial__warning agenda-item-financial__warning--imbalance" role="note">` +
            `Note: The Summary Sheet shows an imbalance of ${escapeHtml(imb)} between the decrease and increase amounts.${pdfLink}` +
            `</p>`;
    }

    const warningHtml = [coaWarningHtml, imbalanceWarningHtml].filter(Boolean).join('\n');

    return wrapSection(`<section class="agenda-item-financial" aria-labelledby="financial-${escapeHtml(fundingItem.agendaItemId)}">
<h4 id="financial-${escapeHtml(fundingItem.agendaItemId)}" class="agenda-item-section__heading">Financial impact</h4>
${fisHtml}
${totalsHtml ? `<dl class="agenda-item-financial__totals">${totalsHtml}</dl>` : ''}
${futureHtml}
${sourcesHtml}
${warningHtml}
</section>`, options);
}

// ------------------------------------------------------------------
// Top-of-agenda overview
// ------------------------------------------------------------------

/**
 * Sum the gross dollar magnitude of all rows on a funding item, regardless
 * of type. This is the "size" of an item from a layperson's perspective:
 * how many dollars does this resolution move? A grant acceptance and a
 * contract award of the same value rank equally.
 */
function _itemGrossMagnitude(item) {
    const rows = item.rows || [];
    return rows.reduce((s, r) => s + Math.abs(r.value || 0), 0);
}

/**
 * Trim the resolution title to a short blurb for the biggest-items list.
 * The manifest's `title` field is the agenda body text which often starts
 * with the file-number line, plus "(Part N of M)" parenthetical, plus
 * boilerplate like "Resolution approving an agreement...". Strip all of
 * those so the snippet is purely the substantive description, then cap.
 */
function _shortenTitle(title) {
    if (!title) return '';
    let s = String(title).trim();
    // Drop leading "File No. XXX-NNNNN" line if present.
    s = s.replace(/^File\s+No\.\s+\S+\s*/i, '');
    // Repeatedly drop leading parenthetical lead-ins like
    // "(Part 2 of 2)" "(See Item )" "(Placed under Staff Reports…)".
    // City staff often chain two or three of these on budget items.
    let prev;
    do {
        prev = s;
        s = s.replace(/^\s*\([^)]*\)\s*/, '');
    } while (s !== prev);
    // Drop common resolution lead-in verbs.
    s = s.replace(/^Resolution\s+(approving|authorizing|making|adopting|accepting|amending|consenting)\s+/i, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > 140) s = s.slice(0, 137).replace(/\s+\S*$/, '') + '…';
    return s;
}

function renderAgendaFundingOverview(manifest) {
    if (!manifest || !manifest.summary) return '';
    const summary = manifest.summary;
    const totals = summary.totals || {};
    const committed = totals.committed || {};
    const future = totals.future || {};
    const headlineFy = totals.headlineFiscalYear || null;

    const spendingAuthorized = committed.expenditures || 0;
    const revenueAccepted = committed.revenues || 0;
    const spendingReduced = committed.decreases || 0;
    const revenueReduced = committed.revenueDecreases || 0;

    const hasAnyDollars =
        spendingAuthorized || revenueAccepted || spendingReduced || revenueReduced ||
        future.expenditures || future.decreases || future.revenues || future.revenueDecreases;
    if (!hasAnyDollars) return '';

    const itemsWithFunding = (manifest.items || []).filter(itemHasResolvedFunding).length;

    let trulyUnknownItems = 0;
    const unknownCodes = new Set();
    for (const it of manifest.items || []) {
        let itemHasUnknown = false;
        for (const r of it.rows || []) {
            const segs = r.unresolved || [];
            if (!segs.length) continue;
            const e = r.enriched || {};
            if (e.fund && e.department && e.object && !e.project) continue;
            itemHasUnknown = true;
            for (const u of segs) unknownCodes.add(u);
        }
        if (itemHasUnknown) trulyUnknownItems += 1;
    }

    // Two plain-language headline numbers. No netting; revenue and
    // expenditures are not opposites to a layperson — they are different
    // categories of dollars Council is approving today.
    const fyTag = headlineFy ? ` (${headlineFy})` : '';
    const headlineRows = [];
    if (spendingAuthorized) {
        headlineRows.push(
            `<div class="agenda-funding-overview__stat"><dt>Spending authorized${escapeHtml(fyTag)}</dt><dd>${escapeHtml(formatMoney(spendingAuthorized, { compact: true }))}</dd></div>`
        );
    }
    if (revenueAccepted) {
        headlineRows.push(
            `<div class="agenda-funding-overview__stat"><dt>Grants &amp; revenue accepted${escapeHtml(fyTag)}</dt><dd>${escapeHtml(formatMoney(revenueAccepted, { compact: true }))}</dd></div>`
        );
    }
    if (spendingReduced) {
        headlineRows.push(
            `<div class="agenda-funding-overview__stat"><dt>Spending reduced${escapeHtml(fyTag)}</dt><dd>${escapeHtml(formatMoney(spendingReduced, { compact: true }))}</dd></div>`
        );
    }
    if (revenueReduced) {
        headlineRows.push(
            `<div class="agenda-funding-overview__stat"><dt>Revenue reduced${escapeHtml(fyTag)}</dt><dd>${escapeHtml(formatMoney(revenueReduced, { compact: true }))}</dd></div>`
        );
    }
    const statsHtml = headlineRows.length
        ? `<dl class="agenda-funding-overview__stats">${headlineRows.join('')}</dl>`
        : '';

    // Biggest items — a layperson-friendly answer to "what costs the most
    // this week?". Ranked by gross dollar magnitude, item number first so
    // a reader can jump straight to it.
    const allRanked = (manifest.items || [])
        .filter(itemHasResolvedFunding)
        .map(it => ({ item: it, gross: _itemGrossMagnitude(it) }))
        .filter(x => x.gross > 0)
        .sort((a, b) => b.gross - a.gross);
    const ranked = allRanked.slice(0, 5);
    const smallest = allRanked.length ? allRanked[allRanked.length - 1] : null;
    const biggest = allRanked.length ? allRanked[0] : null;

    // Range sentence — copy-paste-ready prose for the meeting preview.
    // Format mirrors how the user writes intros: "Council will be approving
    // X items this week ranging from $A (item N, short title) to
    // $B (item M, short title)." Only show when biggest != smallest.
    const rangeSentence = (biggest && smallest && biggest !== smallest)
        ? `Council will consider ${itemsWithFunding} item${itemsWithFunding === 1 ? '' : 's'} with budget detail this week, ranging from <strong>${escapeHtml(formatMoney(biggest.gross, { compact: true }))}</strong> (Item ${escapeHtml(String(biggest.item.itemNumber))} · ${escapeHtml(_shortenTitle(biggest.item.title)).slice(0, 80)}…) down to <strong>${escapeHtml(formatMoney(smallest.gross))}</strong> (Item ${escapeHtml(String(smallest.item.itemNumber))} · ${escapeHtml(_shortenTitle(smallest.item.title)).slice(0, 80)}…).`
        : '';
    const rangeHtml = rangeSentence
        ? `<p class="agenda-funding-overview__range">${rangeSentence}</p>`
        : '';

    const biggestItemsHtml = ranked.length
        ? `<h4 class="agenda-funding-overview__biggest-heading">Biggest items this meeting</h4>
<ol class="agenda-funding-overview__biggest">
${ranked.map(({ item, gross }) => {
    const num = item.itemNumber != null ? `Item ${item.itemNumber}` : '';
    const file = item.fileNumber ? `File No. ${item.fileNumber}` : '';
    const meta = [num, file].filter(Boolean).join(' · ');
    const linkTarget = item.agendaItemId ? `#item-${escapeHtml(item.agendaItemId)}` : '';
    const titleHtml = linkTarget
        ? `<a href="${linkTarget}">${escapeHtml(_shortenTitle(item.title))}</a>`
        : escapeHtml(_shortenTitle(item.title));
    return (
        `<li class="agenda-funding-overview__biggest-item">` +
            `<span class="agenda-funding-overview__biggest-amount">${escapeHtml(formatMoney(gross, { compact: true }))}</span>` +
            `<span class="agenda-funding-overview__biggest-meta">${escapeHtml(meta)}</span>` +
            `<span class="agenda-funding-overview__biggest-title">${titleHtml}</span>` +
        `</li>`
    );
}).join('\n')}
</ol>`
        : '';

    // Smallest item — a single-line sibling to the biggest list, calling
    // out the floor of the range so the reader can see the spread.
    const smallestHtml = (smallest && smallest !== biggest)
        ? (() => {
            const item = smallest.item;
            const num = item.itemNumber != null ? `Item ${item.itemNumber}` : '';
            const file = item.fileNumber ? `File No. ${item.fileNumber}` : '';
            const meta = [num, file].filter(Boolean).join(' · ');
            const linkTarget = item.agendaItemId ? `#item-${escapeHtml(item.agendaItemId)}` : '';
            const titleHtml = linkTarget
                ? `<a href="${linkTarget}">${escapeHtml(_shortenTitle(item.title))}</a>`
                : escapeHtml(_shortenTitle(item.title));
            return `<p class="agenda-funding-overview__smallest"><strong>Smallest item with budget detail:</strong> <span class="agenda-funding-overview__smallest-amount">${escapeHtml(formatMoney(smallest.gross))}</span> · <span class="agenda-funding-overview__smallest-meta">${escapeHtml(meta)}</span> · <span class="agenda-funding-overview__smallest-title">${titleHtml}</span></p>`;
        })()
        : '';

    const futureGross =
        (future.expenditures || 0) +
        (future.decreases || 0) +
        (future.revenues || 0) +
        (future.revenueDecreases || 0);
    const futureLine = futureGross
        ? `<p class="agenda-funding-overview__future">Plus <strong>${escapeHtml(formatMoney(futureGross, { compact: true }))}</strong> in future-year amounts subject to annual Council approval.</p>`
        : '';

    const warning = trulyUnknownItems
        ? `<p class="agenda-funding-overview__warning" role="note">${trulyUnknownItems} item${trulyUnknownItems === 1 ? '' : 's'} reference ${unknownCodes.size} account code${unknownCodes.size === 1 ? '' : 's'} not yet published in the City's public chart of accounts.</p>`
        : '';

    const itemsLine = `<p class="agenda-funding-overview__count"><small>Across ${itemsWithFunding} item${itemsWithFunding === 1 ? '' : 's'} on the agenda with budget detail.</small></p>`;

    return `
<!-- wp:group {"className":"agenda-funding-overview"} -->
<div class="wp-block-group agenda-funding-overview">
<!-- wp:html -->
<h3 class="agenda-funding-overview__heading">What's being approved <span class="agenda-funding-overview__beta" title="This summary is generated automatically from agenda Summary Sheets and is still being refined.">Beta</span></h3>
${rangeHtml}
${statsHtml}
${futureLine}
${biggestItemsHtml}
${smallestHtml}
${itemsLine}
${warning}
<!-- /wp:html -->
</div>
<!-- /wp:group -->
`;
}

module.exports = {
    loadFundingManifest,
    buildFundingByItemId,
    renderItemFinancialSection,
    renderAgendaFundingOverview,
    itemHasResolvedFunding,
    itemHasFinancialData,
    formatMoney,
    escapeHtml,
};

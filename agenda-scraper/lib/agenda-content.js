/**
 * Shared agenda content helpers — emitter-agnostic.
 *
 * These functions clean and structure scraped agenda text without committing
 * to any output dialect. Both emitters use them:
 *   - json-to-wordpress.js  (WP block HTML, legacy — retires with WordPress)
 *   - json-to-markdown.js   (Markdown + front matter for tm-static)
 *
 * Moved out of json-to-wordpress.js so the WP emitter can be deleted wholesale
 * when the migration lands.
 */

'use strict';

/**
 * File-number token as the clerk writes it: "CM26-26209", "REZ-26-12",
 * "AB2-25-11", "SU1-26-08-C", "TA/CPA26-3", "E2026-8", "CM26-1/CM26-2".
 * Bounded (no greedy [A-Z0-9-]+) so a title glued straight onto the number
 * — "PS26-25956Resolution", "VAC-26-07Public" — doesn't swallow the word.
 */
const FILE_NUMBER_TOKEN = String.raw`(?:TA\/CPA|[A-Z]{1,5})\d{0,4}-?\d{1,6}(?:-\d{1,6})?(?:-[A-Z])?(?:\/[A-Z]{1,5}\d{0,4}-\d{1,6})?`;
// "File No. X" anywhere, or a bare / "File. X" number at the head of the text.
const GLUED_FILE_NUMBER_RE = new RegExp(String.raw`(File No\. ${FILE_NUMBER_TOKEN}|^\s*(?:File\.?\s*)?${FILE_NUMBER_TOKEN})(?=[A-Za-z])`, 'gi');
const LEADING_FILE_NUMBER_RE = new RegExp(String.raw`^\s*(?:File\.?\s*(?:No\.?\s*)?)?(${FILE_NUMBER_TOKEN})(?![A-Za-z0-9\-\/])`, 'i');

/**
 * Memo / email transmission sentences ("Memorandum from X, Title, transmitting
 * … for said agenda item. (To be R/F)"). cleanAgendaContent strips these from
 * item descriptions; extractTransmittalNotes pulls them out for the addendum
 * digest, where the memo IS the news.
 */
const TRANSMITTAL_PATTERNS = [
    /\s*Memorandum from [^.]*?(?:,\s*(?:notifying|transmitting|advising|requesting|recommending)[^.]*)+\.\s*(?:\(To be R\/F\))?/gi,
    /\s*Email from [^.]*?(?:,\s*(?:notifying|transmitting|advising|requesting|recommending)[^.]*)+\.\s*(?:\(To be R\/F\))?/gi,
    // Fallback: multi-clause sentences, terminated by "for said item" or "(To be R/F)"
    /\s*Memorandum from [^]*?(?:for said (?:agenda )?(?:item|public hearing)|To be R\/F)[^.]*\.?\s*(?:\(To be R\/F\))?/gi,
    /\s*Email from [^]*?(?:for said (?:agenda )?(?:item|public hearing)|To be R\/F)[^.]*\.?\s*(?:\(To be R\/F\))?/gi,
];

/**
 * The file number at the head of raw agenda text ("File No. PS26-25956…"),
 * bounded by FILE_NUMBER_TOKEN so glued titles don't leak in. Null if the
 * text doesn't start with one.
 * @param {string} content
 * @returns {string|null}
 */
function leadingFileNumber(content) {
    const m = (content || '').replace(GLUED_FILE_NUMBER_RE, '$1 ').match(LEADING_FILE_NUMBER_RE);
    return m ? m[1] : null;
}

/**
 * Return the memo/email transmission sentences in raw agenda text, cleaned
 * of "(To be R/F)" / "(Title of … listed below)" tags. Empty array if none.
 * @param {string} content
 * @returns {string[]}
 */
function extractTransmittalNotes(content) {
    const notes = [];
    let rest = content || '';
    for (const pattern of TRANSMITTAL_PATTERNS) {
        rest = rest.replace(pattern, (match) => {
            const note = match
                .replace(/\(To be R\/F\)/gi, '')
                .replace(/\(Title of [^)]*listed below\)/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (note) notes.push(/[.?!]$/.test(note) ? note : note + '.');
            return ' ';
        });
    }
    return notes;
}

/**
 * Strip legal boilerplate and transmission memos from raw agenda item text.
 * @param {string} content - Raw agenda item text
 * @returns {string} - Cleaned text (file numbers marked with **bold**)
 */
function cleanAgendaContent(content) {
    // Strip a memo/email transmission sentence unless it requests a
    // continuance (e.g. "requesting that said agenda item be continued to
    // July 23, 2026") — those memos carry real scheduling information.
    const stripUnlessContinuance = (match) => /continu/i.test(match) ? match : ' ';

    // First preserve file numbers with proper formatting
    let cleaned = content
        // Un-glue a title jammed onto the file number ("PS26-25956Resolution")
        .replace(GLUED_FILE_NUMBER_RE, '$1 ')
        // Format file numbers consistently
        .replace(/(File No\. [A-Za-z0-9\/\-]+)/gi, '**$1**')
        // Also handle bare file numbers at start of text (e.g., "TA/CPA25-20 Transmittal...")
        .replace(/^((?:DE[12]|TA\/CPA|REZ|VAC|AB[12]|SU\d?)\d{2}-\d+)\b/i, '**File No. $1**')

        // Remove email/memo transmission sentences (but preserve any that
        // request a continuance — see stripUnlessContinuance above)
        // Match from "Memorandum from" to the end of the sentence, handling titles with periods (P.E., Ph.D., etc.)
        // Match pattern: "Memorandum from [name with possible periods], [title], [action verb] [content]. (To be R/F)"
        .replace(/\s*Memorandum from [^.]*?(?:,\s*(?:notifying|transmitting|advising|requesting|recommending)[^.]*)+\.\s*(?:\(To be R\/F\))?/gi, stripUnlessContinuance)
        .replace(/\s*Email from [^.]*?(?:,\s*(?:notifying|transmitting|advising|requesting|recommending)[^.]*)+\.\s*(?:\(To be R\/F\))?/gi, stripUnlessContinuance)
        // Fallback: Match entire paragraph starting with Memorandum/Email from (handles multi-clause sentences)
        .replace(/\s*Memorandum from [^]*?(?:for said (?:agenda )?item|To be R\/F)[^.]*\.?\s*(?:\(To be R\/F\))?/gi, stripUnlessContinuance)
        .replace(/\s*Email from [^]*?(?:for said (?:agenda )?item|To be R\/F)[^.]*\.?\s*(?:\(To be R\/F\))?/gi, stripUnlessContinuance)

        // Remove standalone "transmitting" phrases (e.g., ", transmitting a PowerPoint presentation for said agenda item.")
        .replace(/,?\s*(?:and\s+)?transmitting (?:a |an )?(?:PowerPoint |written )?(?:presentation|response|report|memo|memorandum)[^\.]*for said (?:agenda )?item\.?/gi, '')

        // Normalize spacing
        .replace(/\s+/g, ' ').trim()

        // "(Title of [substitute] resolution/ordinance listed below)" + the
        // full legal title(s) that follow: a clerk's convention for attaching
        // a substitute or companion instrument. When the item already has a
        // description, the restated title only duplicates it (and can triple
        // the length — 8/27/26 item 80 grew three resolution titles). Keep
        // the tail only when it is the item's sole description.
        .replace(/\s*\(Title of [^)]*listed below\)\s*([^]*)$/i, (m, tail, offset, str) => {
            const before = str.slice(0, offset)
                .replace(/\*\*[^*]*\*\*/g, '')
                .replace(/\([^)]*\)/g, '')
                .replace(/[\s\-–—:;,.]+/g, ' ')
                .trim();
            return before.length >= 40 ? '' : ' ' + tail;
        })

        // Remove parenthetical notes - these don't change meaning
        // Also remove any preceding dash/hyphen before the parenthetical
        .replace(/\s*-\s*\(Ordinance being presented[^)]*\)/gi, '')
        .replace(/\s*-\s*\(To be R\/F\)/gi, '')
        .replace(/\s*-\s*\(Updated[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Original [Mm]otion[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Continued from[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Motion to reschedule[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Motion adopting[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Motion requesting[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Amended motion[^)]*\)/gi, '')
        .replace(/\s*-\s*\(Next [^)]*\)/gi, '')
        .replace(/\s*-\s*\(First (discussion|public hearing)[^)]*\)/gi, '')
        // Fallback without dash prefix
        .replace(/\(Ordinance being presented[^)]*\)/gi, '')
        .replace(/\(To be R\/F\)/gi, '')
        .replace(/\(Updated[^)]*\)/gi, '')
        .replace(/\(Original [Mm]otion[^)]*\)/gi, '')
        .replace(/\(Continued from[^)]*\)/gi, '')
        .replace(/\(Motion to reschedule[^)]*\)/gi, '')
        .replace(/\(Motion adopting[^)]*\)/gi, '')
        .replace(/\(Motion requesting[^)]*\)/gi, '')
        .replace(/\(Amended motion[^)]*\)/gi, '')
        .replace(/\(Next [^)]*\)/gi, '')
        .replace(/\(First (discussion|public hearing)[^)]*\)/gi, '')

        // The ending-phrase rules below are $-anchored; a parenthetical
        // removed above leaves trailing whitespace that would defeat them.
        .replace(/\s+$/, '')

        // Remove ONLY standard ending phrases - these are truly boilerplate
        .replace(/;\s*providing an effective date\.?$/gi, '.')
        .replace(/;\s*providing for severability\.?$/gi, '.')
        .replace(/;\s*providing for repeal of all ordinances in conflict\.?$/gi, '.')
        .replace(/;\s*repealing conflicts\.?$/gi, '.')

        // Optimized authorization patterns - handle combinations and standalone patterns

        // 1. Authorization + following boilerplate in one pass
        .replace(/;\s*authorizing the Director of Purchasing to purchase said property, supplies, materials or services(?:;\s*(?:and\s+)?providing\s+(?:(?:for\s+)?(?:an\s+)?effective\s+date|for\s+severability|for\s+repeal\s+of\s+all\s+ordinances\s+in\s+conflict)|;\s*repealing\s+conflicts)*\.?\s*$/gi, '.')
        // Match "authorizing the Mayor of the City of Tampa to execute said contract on behalf of the City of Tampa"
        .replace(/;\s*authorizing\s+(?:the\s+)?Mayor(?:\s+of\s+the\s+City\s+of\s+Tampa)?\s+to\s+execute\s+said\s+(?:contract|agreement)(?:\s+on\s+behalf\s+of\s+the\s+City\s+of\s+Tampa)?\.?\s*$/gi, '.')
        .replace(/;\s*authorizing\s+(?:the\s+execution\s+thereof\s+by\s+)?(?:the\s+)?Mayor(?:\s+(?:of|or)\s+the\s+City\s+of\s+Tampa)?\s+to\s+execute\s+(?:same|said\s+(?:cooperative\s+)?(?:agreement|contract)(?:\s+and\s+order\s+form)?|said\s+Amendment|said\s+Change\s+Order)(?:\s+on\s+behalf\s+of\s+the\s+City\s+of\s+Tampa)?(?:;\s*(?:and\s+)?providing\s+(?:(?:for\s+)?(?:an\s+)?effective\s+date|for\s+severability|for\s+repeal\s+of\s+all\s+ordinances\s+in\s+conflict)|;\s*repealing\s+conflicts)*\.?\s*$/gi, '.')
        // Match common pattern: "authorizing execution by the Mayor and attestation by the City Clerk; Providing an effective date"
        .replace(/;\s*authorizing\s+execution\s+by\s+the\s+Mayor\s+and\s+attestation\s+by\s+the\s+(?:City\s+)?Clerk;\s*(?:and\s+)?Providing\s+an\s+effective\s+date\s*\.?\s*$/gi, '.')
        // Match "authorizing execution by the Mayor and attestation by the Clerk" (with or without "the")
        .replace(/;\s*authorizing\s+(?:the\s+)?execution(?:\s+thereof)?\s+by\s+(?:the\s+)?Mayor(?:\s+(?:of|or)\s+the\s+City\s+of\s+Tampa)?(?:\s+and\s+attestation\s+by\s+the\s+(?:City\s+)?Clerk)?(?:;\s*(?:and\s+)?providing\s+(?:(?:for\s+)?(?:an\s+)?effective\s+date|for\s+severability|for\s+repeal\s+of\s+all\s+ordinances\s+in\s+conflict)|;\s*repealing\s+conflicts)*\.?\s*$/gi, '.')

        // 2. Standalone ending phrases (fallback for any remaining)
        .replace(/;\s*(?:and\s+)?providing\s+(?:(?:for\s+)?(?:an\s+)?effective\s+date|for\s+severability|for\s+repeal\s+of\s+all\s+ordinances\s+in\s+conflict)\.?\s*$/gi, '.')
        .replace(/;\s*repealing\s+conflicts\.?\s*$/gi, '.')
        .replace(/;\s*providing for an effective date\.?\s*$/gi, '.')

        // Fix any punctuation issues
        .replace(/,\s*;/g, ';')
        .replace(/,\s*\./g, '.')
        .replace(/:\s*\./g, '.')
        .replace(/;\s*\./g, '.')
        .replace(/\.\s*\.$/g, '.') // Fix double periods

        // Clean up stray dashes (from removed parentheticals)
        .replace(/\s+-\s+-\s*/g, ' ')  // Multiple dashes with spaces
        .replace(/\s+-\s*$/g, '')      // Trailing dash
        .replace(/\s+-\s+\./g, '.')    // Dash before period

        // Clean up trailing fragments like "and ." or ", and ."
        .replace(/,?\s+and\s+\.$/gi, '.')
        .replace(/,\s+\.$/g, '.')

        // Normalize multiple spaces
        .replace(/\s+/g, ' ')
        .trim();

    // Ensure ends with period if not already (but check more carefully)
    if (cleaned && !/[.?!]$/.test(cleaned.trim())) {
        cleaned += '.';
    }

    // Final check for double periods
    cleaned = cleaned
        .replace(/\.\s*\.$/g, '.')  // Fix double periods at end
        .replace(/\.\s+\.$/g, '.'); // Fix period-space-period at end

    return cleaned;
}

/**
 * Split a waiver blob ("1. foo. 2. bar. 3. baz") into individual items.
 * Splits on whitespace that precedes a cardinal number + ". " sequence, but a
 * number only starts a new item when it continues the sequence (1, 2, 3, …).
 * That keeps sentence-final numbers ("…loading berths from 4 to 0.") and
 * section codes like "27-284.2.5" from being treated as split points.
 */
function splitNumberedWaivers(text) {
    const chunks = text.split(/\s+(?=\d{1,2}\.\s)/).map(s => s.trim()).filter(Boolean);
    if (!chunks.length) return [];
    const first = chunks[0].match(/^(\d{1,2})\.\s/);
    const items = [chunks[0]];
    let expected = first ? Number(first[1]) + 1 : 1;
    for (let i = 1; i < chunks.length; i++) {
        const m = chunks[i].match(/^(\d{1,2})\.\s/);
        if (m && Number(m[1]) === expected) {
            items.push(chunks[i]);
            expected++;
        } else {
            items[items.length - 1] += ' ' + chunks[i];
        }
    }
    return items;
}

/**
 * Format land use staff report data as a semantic HTML section.
 *
 * Always renders when any field is present. Plain HTML — the WP emitter
 * wraps it in wp:html; the markdown emitter uses it verbatim.
 * Mirrors the visual pattern of agenda-item-financial sections:
 *   <section aria-labelledby> / <dl> for facts / <ol> for ordered waivers.
 *
 * @param {object} staffReport - staffReport object from agendaItem
 * @param {string|number} agendaItemId - used for aria-labelledby
 * @returns {string} - HTML string, or empty string when nothing to render
 */
function formatStaffReportSection(staffReport, agendaItemId) {
    if (!staffReport) return '';

    const id = agendaItemId ? String(agendaItemId) : 'unknown';
    const labelId = `land-use-${id}`;
    const parts = [];

    // --- Key/value fact table (zoning, FLU, neighbourhood associations) ---
    const factRows = [];

    if (staffReport.currentZoning || staffReport.requestedZoning) {
        let zoningVal;
        if (staffReport.currentZoning && staffReport.requestedZoning) {
            zoningVal = `${staffReport.currentZoning} → ${staffReport.requestedZoning}`;
        } else if (staffReport.currentZoning) {
            zoningVal = staffReport.currentZoning;
        } else {
            zoningVal = `Requested: ${staffReport.requestedZoning}`;
        }
        factRows.push(`<div class="agenda-item-land-use__fact"><dt>Zoning</dt><dd>${zoningVal}</dd></div>`);
    }

    if (staffReport.futureLandUse) {
        factRows.push(`<div class="agenda-item-land-use__fact"><dt>Future land use</dt><dd>${staffReport.futureLandUse}</dd></div>`);
    }

    if (staffReport.overlayDistrict) {
        factRows.push(`<div class="agenda-item-land-use__fact"><dt>Overlay district</dt><dd>${staffReport.overlayDistrict}</dd></div>`);
    }

    const assocs = Array.isArray(staffReport.neighborhoodAssociations)
        ? staffReport.neighborhoodAssociations.filter(Boolean)
        : [];
    if (assocs.length) {
        const label = assocs.length === 1 ? 'Neighborhood association' : 'Neighborhood associations';
        const dds = assocs.map(a => `<dd>${a}</dd>`).join('');
        factRows.push(`<div class="agenda-item-land-use__fact"><dt>${label}</dt>${dds}</div>`);
    }

    if (factRows.length) {
        parts.push(`<dl class="agenda-item-land-use__facts">${factRows.join('')}</dl>`);
    }

    // --- Waivers as an ordered list ---
    const waiverBlobs = Array.isArray(staffReport.waivers) ? staffReport.waivers : [];
    const waiverItems = [];
    for (const blob of waiverBlobs) {
        // Strip section label left over from the parser ("WAIVER(S) REQUESTED:", etc.)
        const stripped = blob
            .replace(/^(?:PREVIOUSLY APPROVED WAIVERS.*?:|NEW WAIVER.*?REQUESTED:\s*|WAIVER\(S\)\s*REQUESTED:\s*)/i, '')
            .trim();
        if (stripped) waiverItems.push(...splitNumberedWaivers(stripped));
    }
    if (waiverItems.length) {
        // Strip leading "N. " numbering — the <ol> provides the count.
        const lis = waiverItems
            .map(w => w.replace(/^\d{1,2}\.\s+/, '').trim())
            .filter(Boolean)
            .map(w => `<li>${w}</li>`)
            .join('');
        parts.push(
            `<h5 class="agenda-item-land-use__waivers-heading">Waivers requested</h5>` +
            `<ol class="agenda-item-land-use__waivers">${lis}</ol>`
        );
    }

    // --- Staff findings ---
    if (staffReport.findings) {
        const clean = staffReport.findings.replace(/^FINDINGS:\s*/i, '').trim();
        if (clean) {
            parts.push(`<p class="agenda-item-land-use__findings"><strong>Staff findings:</strong> ${clean}</p>`);
        }
    }

    if (!parts.length) return '';

    return `<section class="agenda-item-land-use" aria-labelledby="${labelId}">
<h4 id="${labelId}" class="agenda-item-section__heading">Land use details</h4>
${parts.join('\n')}
</section>`;
}

/**
 * Format a UTC date key (YYYY-MM-DD) to a friendly string like "Tuesday, December 9, 2025".
 * @param {string} dateKey
 * @returns {string}
 */
function formatChangeLogDate(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'UTC',
    });
}

module.exports = {
    cleanAgendaContent,
    extractTransmittalNotes,
    leadingFileNumber,
    splitNumberedWaivers,
    formatStaffReportSection,
    formatChangeLogDate,
};

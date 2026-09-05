#!/usr/bin/env node
/**
 * json-to-markdown.js — emit a tm-static markdown post from scraped meeting JSON.
 *
 * Successor to json-to-wordpress.js for the WordPress → tm-static migration.
 * Markup contract: docs/plans/AGENDA-MARKUP.md (meetings repo) — new BEM
 * vocabulary (agenda__section / agenda-item / agenda-item__* / agenda__changes),
 * item numbers as text, items as <h3> headings under real <h2> section
 * headings, What's-Changed entries as digests with is-new document chips.
 *
 * Output:
 *   agendas/agenda_<date>.md                     — always (pipeline record)
 *   $TM_STATIC_POSTS_DIR/<pubdate>-<slug>.md     — when the env var or --dest
 *                                                  is set; re-runs overwrite
 *                                                  the existing post for the
 *                                                  same slug and keep its
 *                                                  original filename + date.
 *
 * Usage:
 *   node json-to-markdown.js --date 2026-07-23
 *   node json-to-markdown.js 2815               # meeting id(s)
 *   node json-to-markdown.js --date 2026-07-23 --dest ~/tampa-monitor/tm-static/src/posts
 *       [--slug 7-23-26-regular-meeting] [--title "7-23-26 Regular Meeting"]
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
    loadFundingManifest,
    buildFundingByItemId,
    renderItemFinancialSection,
    escapeHtml,
} = require('./lib/render-funding');
const { loadChangeLog } = require('./lib/change-log');
const {
    cleanAgendaContent,
    extractTransmittalNotes,
    leadingFileNumber,
    formatStaffReportSection,
    formatChangeLogDate,
} = require('./lib/agenda-content');

const DATA_DIR = path.join(__dirname, 'data');
const RECORD_DIR = path.join(__dirname, 'agendas');

// ------------------------------------------------------------------
// Meeting loading (same conventions as json-to-wordpress.js)
// ------------------------------------------------------------------

function loadJSONData(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Error loading JSON file ${filePath}:`, error.message);
        return null;
    }
}

function findJSONFilesForDate(date) {
    try {
        return fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith('meeting_') && f.endsWith('.json') && f.includes(date))
            .map(f => path.join(DATA_DIR, f));
    } catch (error) {
        console.error('Error reading data directory:', error.message);
        return [];
    }
}

function loadMeetings({ meetingIds, date }) {
    const meetings = [];
    const loadedIds = new Set();

    const addMeeting = (m) => {
        if (m && !loadedIds.has(m.meetingId)) {
            meetings.push(m);
            loadedIds.add(m.meetingId);
        }
    };

    if (date) {
        for (const filePath of findJSONFilesForDate(date)) {
            addMeeting(loadJSONData(filePath));
        }
    }

    for (const meetingId of meetingIds) {
        const files = fs.readdirSync(DATA_DIR).filter(f =>
            f.startsWith(`meeting_${meetingId}_`) && f.endsWith('.json'));
        if (!files.length) {
            console.warn(`No JSON file found for meeting ID ${meetingId}`);
            continue;
        }
        addMeeting(loadJSONData(path.join(DATA_DIR, files[0])));
    }

    // Auto-load addendum meetings sharing a date with a loaded meeting.
    for (const meetingDate of new Set(meetings.map(m => m.formattedDate).filter(Boolean))) {
        for (const filePath of findJSONFilesForDate(meetingDate)) {
            const m = loadJSONData(filePath);
            if (m && m.isAddendum) addMeeting(m);
        }
    }

    // Morning meetings first, evening last (same ordering as the WP emitter).
    meetings.sort((a, b) => {
        const pri = (t) => /evening/.test((t || '').toLowerCase()) ? 999 : 1;
        return (pri(a.meetingType) - pri(b.meetingType)) ||
            (parseInt(a.meetingId, 10) - parseInt(b.meetingId, 10));
    });

    return meetings;
}

// ------------------------------------------------------------------
// Section titles
// ------------------------------------------------------------------

const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'to', 'by', 'for', 'in', 'on', 'a', 'an', 'at', 'with']);
const KEEP_UPPER = new Set(['CRA', 'ADA', 'LLC', 'FDOT', 'HUD', 'CDBG', 'TPD', 'CIP']);

/**
 * Title-case an ALL-CAPS OnBase section header; mixed-case input is
 * returned untouched. Times ("5:01"), dotted abbreviations ("P.M.") and
 * known acronyms keep their casing.
 */
function titleCaseFromCaps(s) {
    if (s !== s.toUpperCase()) return s;
    return s.split(' ').map((word, i) => {
        if (/[\d.]/.test(word)) return word;
        if (KEEP_UPPER.has(word.replace(/[^A-Z]/g, ''))) return word;
        const lower = word.toLowerCase();
        if (i > 0 && SMALL_WORDS.has(lower)) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
}

/**
 * Normalize a raw scraped section header for display:
 * strip trailing "(ITEMS …)" ranges, colons, and dangling dashes, then
 * title-case. OnBase also writes "AND\OR" with a stray backslash — fold it
 * to a slash. Order matters: the trailing colon comes off first, because
 * some headers put it AFTER the range ("… CONSENT - (Item 39):").
 */
function normalizeSectionTitle(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\s+/g, ' ').replace(/\\/g, '/').trim();
    s = s.replace(/\s*:\s*$/, '');                          // trailing colon
    s = s.replace(/\s*[-–—]?\s*\(ITEMS?[^)]*\)\s*$/i, '');  // trailing (Items N–M) range
    s = s.replace(/\s*[-–—]\s*$/, '');                       // dangling trailing dash
    if (!s) return null;
    return titleCaseFromCaps(s);
}

/**
 * Group a meeting's items into ordered sections, merging consecutive
 * sections whose normalized titles match (OnBase splits "PUBLIC HEARINGS"
 * into per-item-range rows). Items with no section data fall into a
 * fallback section so old JSON keeps working.
 */
function groupItemsBySection(items, fallbackTitle) {
    const groups = [];
    for (const item of items) {
        const scraped = normalizeSectionTitle(item.section);
        const title = scraped || fallbackTitle;
        const last = groups[groups.length - 1];
        if (last && last.title === title) {
            last.items.push(item);
        } else {
            groups.push({ title, items: [item], isFallback: !scraped });
        }
    }
    return groups;
}

const COMMITTEE_RE = /\bcommittee$/i;

/**
 * Editorial restructure: the printed agenda lists the consent business as a
 * run of per-committee report sections (Public Safety Committee, Finance
 * Committee, …). The site groups that run under one "Consent Agenda" <h2>
 * with the committees as <h3> sub-heads — the source outline is not the
 * product. Runs of 2+ consecutive committee sections are grouped; a lone
 * committee section (not a consent run) is left as its own section.
 */
function groupConsentSections(groups) {
    const out = [];
    let i = 0;
    while (i < groups.length) {
        if (!COMMITTEE_RE.test(groups[i].title)) {
            out.push(groups[i++]);
            continue;
        }
        const run = [];
        while (i < groups.length && COMMITTEE_RE.test(groups[i].title)) run.push(groups[i++]);
        if (run.length >= 2) {
            out.push({ title: 'Consent Agenda', subgroups: run });
        } else {
            out.push(run[0]);
        }
    }
    return out;
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

/** Drop empty lines so a block stays one CommonMark raw-HTML block. */
function tightBlock(html) {
    return html.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '').join('\n');
}

function slugify(text) {
    return String(text).toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

function docHref(doc) {
    if (doc.mirroredUrl) return doc.mirroredUrl;
    const url = doc.url || '';
    return url.startsWith('http') ? url : 'https://tampagov.hylandcloud.com' + url.replace(/&amp;/g, '&');
}

function onbaseMeetingUrl(sourceUrl) {
    return (sourceUrl || '')
        .replace('/Documents/ViewAgenda', '/Meetings/ViewMeeting')
        .replace('meetingId=', 'id=')
        .replace('&type=agenda', '');
}

// ------------------------------------------------------------------
// Item rendering
// ------------------------------------------------------------------

const MAP_FILE_RE = /^(DE[12]|TA\/CPA|REZ|VAC|AB[12]|SU\d?)/i;

/**
 * Pad a land-use file number's numeric suffix to 7 digits so it matches
 * the Datasette feed's RECORDID (same rule as the WP emitter).
 */
function padFileNumber(fileNo) {
    const [prefix, num] = fileNo.split(/-(?=[^-]+$)/);
    if (num && /^\d+$/.test(num)) return `${prefix}-${num.padStart(7, '0')}`;
    return fileNo;
}

/**
 * Clean an item's raw text and strip the leading file number (it moves to
 * the item heading). Returns { description } — plain text, HTML-escaped.
 */
function itemDescription(item) {
    let cleaned = cleanAgendaContent(item.rawTitle || '');
    if (item.fileNumber) {
        // Remove the bolded file-number token cleanAgendaContent marked up.
        // Tolerate trailing characters inside the bold marker — truncated
        // numbers like "File No. BA26-" bold more than item.fileNumber.
        const esc = item.fileNumber.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
        cleaned = cleaned.replace(new RegExp(`\\*\\*File No\\. ${esc}[^*]*\\*\\*[\\s,.:;–—-]*`, 'i'), '');
    }
    // A leading file number the scraper mis-parsed (e.g. glued "PS26-25956Res")
    // won't match above; the heading carries the number, so drop it anyway.
    // Keep it when a secondary number follows ("CM26-22117 / CM25-18955").
    cleaned = cleaned.replace(/^\*\*File No\. [^*]*\*\*(?!\s*\/)[\s,.:;–—-]*/i, '');
    // Unbold anything left (secondary file-number references stay inline).
    cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    return cleaned.trim();
}

/**
 * Background narrative → tight HTML (list of numbered points + paragraphs),
 * mirroring the WP emitter's structure without block comments.
 */
function formatBackgroundHtml(backgroundText) {
    const chunks = backgroundText.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    const listItems = [];
    const paragraphs = [];
    for (const chunk of chunks) {
        if (/^\d+\.\s/.test(chunk)) listItems.push(chunk.replace(/^\d+\.\s*/, ''));
        else paragraphs.push(chunk);
    }
    let out = '';
    if (listItems.length) {
        out += `<ol>${listItems.map(li => `<li>${escapeHtml(li.replace(/\n/g, ' '))}</li>`).join('')}</ol>`;
    }
    out += paragraphs.map(p => `<p>${escapeHtml(p.replace(/\n/g, ' '))}</p>`).join('\n');
    if (!out) out = `<p>${escapeHtml(backgroundText.replace(/\n/g, ' ').trim())}</p>`;
    return out;
}

/**
 * Render one agenda item as an <article class="agenda-item"> per the
 * markup contract.
 *
 * @param {object} item        Agenda item from meeting JSON
 * @param {object} ctx         { fundingByItemId, newDocKeys, continuedItems,
 *                               updatedItemNums, addendumAnchor }
 * @returns {string}
 */
function renderItem(item, ctx) {
    const anchorId = `item-${item.agendaItemId || `${ctx.meetingId}-${item.number}`}`;
    const headLabel = item.fileNumber ? `File No. ${escapeHtml(item.fileNumber)}` : `Item ${item.number}`;

    const parts = [];
    parts.push(`<article class="agenda-item" id="${anchorId}">`);
    parts.push(`<h3 class="agenda-item__head"><a class="agenda-item__anchor" href="#${anchorId}">${item.number}</a> ${headLabel}</h3>`);

    const description = itemDescription(item);
    if (description) parts.push(`<p>${escapeHtml(description)}</p>`);

    // Index entry for the preamble's featured-item card (see renderFeatured).
    if (ctx.itemIndex) {
        ctx.itemIndex.set(String(item.number), { anchorId, number: item.number, headLabel, description });
    }

    // --- Item details drawer: financial impact, background, land use ---
    const drawerParts = [];
    const fundingItem = ctx.fundingByItemId[String(item.agendaItemId)] || null;
    const fundingItemWithDocs = fundingItem
        ? { ...fundingItem, supportingDocuments: item.supportingDocuments || [] }
        : fundingItem;
    const financial = renderItemFinancialSection(fundingItemWithDocs, item.projectedCosts, { wpWrap: false });
    if (financial) drawerParts.push(financial);

    if (item.background && item.background.trim()) {
        drawerParts.push(`<p class="agenda-item__label">Background</p>\n${formatBackgroundHtml(item.background.trim())}`);
    }

    if (item.staffReport) {
        const landUse = formatStaffReportSection(item.staffReport, item.agendaItemId);
        if (landUse) drawerParts.push(landUse);
    }

    if (drawerParts.length) {
        parts.push(`<details class="agenda-item__details">\n<summary>Item details</summary>\n${drawerParts.join('\n')}\n</details>`);
    }

    // --- Supporting documents (sibling of the drawer — links stay visible) ---
    const docs = item.supportingDocuments || [];
    if (docs.length) {
        const lis = docs.map(doc => {
            const title = doc.title || doc.originalText || 'Document';
            const isNew = ctx.newDocKeys.has(`${item.number}::${norm(title)}`);
            const cls = isNew ? ' class="is-new"' : '';
            return `<li${cls}><a href="${escapeHtml(docHref(doc))}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></li>`;
        }).join('\n');
        parts.push(`<div class="agenda-item__docs">\n<p class="agenda-item__label">Supporting documents</p>\n<ul>\n${lis}\n</ul>\n</div>`);
    }

    // --- Addendum notices ---
    if (ctx.continuedItems.has(item.number)) {
        parts.push(`<p class="agenda-item__notice agenda-item__notice--continuance">⚠️ <strong>Continued to ${escapeHtml(ctx.continuedItems.get(item.number))}</strong> — see <a href="#${ctx.addendumAnchor}">Addendum</a></p>`);
    } else if (ctx.updatedItemNums.has(item.number)) {
        parts.push(`<p class="agenda-item__notice agenda-item__notice--updated">📋 <strong>Updated by Addendum</strong> — see <a href="#${ctx.addendumAnchor}">Addendum</a> for details</p>`);
    }

    parts.push('</article>');
    return parts.join('\n');
}

// ------------------------------------------------------------------
// Map block
// ------------------------------------------------------------------

/**
 * Collect land-use map data for a meeting: which items are mappable and the
 * data-records / data-folios attribute strings tm-static's maps.js reads.
 * Same record/folio formats as the WP emitter (RECORDID:itemNumber, …).
 */
function collectMapData(items) {
    const records = [];
    const folios = [];
    const mappedItemIds = new Set();

    for (const item of items) {
        const fileNo = item.fileNumber || '';
        if (!MAP_FILE_RE.test(fileNo)) continue;
        const padded = padFileNumber(fileNo);
        records.push(`${padded}:${item.number}`);
        mappedItemIds.add(item.agendaItemId);

        const hasFolios = item.folioNumbers && item.folioNumbers.length > 0;
        if (item.coordinates && hasFolios) {
            folios.push(`${padded}:${item.coordinates.lat},${item.coordinates.lng}:${item.folioNumbers.join(',')}`);
        } else if (item.coordinates) {
            folios.push(`${padded}:${item.coordinates.lat},${item.coordinates.lng}`);
        } else if (hasFolios) {
            folios.push(`${padded}:${item.folioNumbers.join(',')}`);
        }
    }

    if (!records.length) return null;
    return {
        mappedItemIds,
        firstMappedItemId: [...mappedItemIds][0],
        html: `<div class="mapbox-block" data-center="[-82.4572,27.9506]" data-zoom="11" data-records="${records.join(', ')}"${folios.length ? ` data-folios="${folios.join('|')}"` : ''} data-show-geocoder="true" data-geocoder-position="top-right" data-show-legend="true" data-legend-position="bottom-left"></div>`,
    };
}

// ------------------------------------------------------------------
// What's changed
// ------------------------------------------------------------------

/**
 * Collect "<itemNumber>::<NORMALIZED FILENAME>" keys for every document the
 * change log recorded as newly mirrored — these get the is-new chip in the
 * item's supporting-docs list.
 */
function collectNewDocKeys(changeLog) {
    const keys = new Set();
    for (const entry of (changeLog && changeLog.entries) || []) {
        for (const doc of entry.newDocuments || []) {
            keys.add(`${doc.itemNumber}::${norm(doc.filename)}`);
        }
    }
    return keys;
}

function changeItemLi(desc, itemAnchorMap) {
    const anchor = desc.agendaItemId ? `#item-${desc.agendaItemId}`
        : itemAnchorMap.has(String(desc.number)) ? `#${itemAnchorMap.get(String(desc.number))}` : null;
    const text = escapeHtml(desc.fileNumber || `Item ${desc.number}`);
    const linked = anchor ? `<a href="${anchor}">${text}</a>` : text;
    // Span keeps the mixed-case title out of the card's lowercase-the-
    // filenames display rule (tm-static agenda.css).
    const title = desc.shortTitle ? ` — <span class="agenda__changes-title">${escapeHtml(desc.shortTitle)}</span>` : '';
    return `<li><strong>${linked}</strong>${title}</li>`;
}

/**
 * Render the "What's changed" section for one meeting. Digest form per the
 * markup contract: item link + document count; the documents themselves are
 * flagged is-new in the item's supporting-docs list.
 */
function renderChangesSection(changeLog, meeting) {
    if (!changeLog || !changeLog.entries || !changeLog.entries.length) return '';

    const itemAnchorMap = new Map();
    for (const item of meeting.agendaItems || []) {
        if (item.number != null && item.agendaItemId != null) {
            itemAnchorMap.set(String(item.number), `item-${item.agendaItemId}`);
        }
    }

    const entryBlocks = [];
    for (const entry of changeLog.entries) {
        const sections = [];

        if (entry.agendaTypePromoted && entry.agendaTypePromoted.to === 'FINAL') {
            sections.push('<p>Agenda was finalized.</p>');
        }

        if (entry.itemsAdded && entry.itemsAdded.length) {
            const lis = entry.itemsAdded.map(d => changeItemLi(d, itemAnchorMap)).join('\n');
            sections.push(`<p>Item${entry.itemsAdded.length > 1 ? 's' : ''} added:</p>\n<ul>\n${lis}\n</ul>`);
        }

        if (entry.itemsRemoved && entry.itemsRemoved.length) {
            const lis = entry.itemsRemoved.map(d => changeItemLi(d, itemAnchorMap)).join('\n');
            sections.push(`<p>Item${entry.itemsRemoved.length > 1 ? 's' : ''} removed:</p>\n<ul>\n${lis}\n</ul>`);
        }

        if (entry.newDocuments && entry.newDocuments.length) {
            // Group new documents by item; emit digest entries, never
            // filename run-ons (the files carry is-new chips on the item).
            const groups = new Map();
            for (const doc of entry.newDocuments) {
                const key = `${doc.itemNumber}::${doc.itemFileNumber}`;
                if (!groups.has(key)) {
                    groups.set(key, { itemNumber: doc.itemNumber, itemFileNumber: doc.itemFileNumber, count: 0 });
                }
                groups.get(key).count += 1;
            }
            const lis = [...groups.values()].map(g => {
                const anchor = itemAnchorMap.get(String(g.itemNumber));
                const label = g.itemFileNumber
                    ? `Item ${g.itemNumber} — ${escapeHtml(g.itemFileNumber)}`
                    : `Item ${g.itemNumber}`;
                const linked = anchor ? `<a href="#${anchor}">${label}</a>` : label;
                return `<li><strong>${linked}</strong> <span class="agenda__changes-note">· ${g.count} new document${g.count === 1 ? '' : 's'}</span></li>`;
            }).join('\n');
            sections.push(`<p>New documents:</p>\n<ul>\n${lis}\n</ul>`);
        }

        if (!sections.length) continue;
        entryBlocks.push(
            `<p class="agenda__changes-date"><time datetime="${entry.date}">${formatChangeLogDate(entry.date)}</time></p>\n${sections.join('\n')}`
        );
    }

    if (!entryBlocks.length) return '';
    return `<section class="agenda__changes">\n<h2>What's changed</h2>\n${entryBlocks.join('\n')}\n</section>`;
}

// ------------------------------------------------------------------
// Addendum section
// ------------------------------------------------------------------

const ADDENDUM_LABELS = {
    walkons: 'Walk-on Items / New Business',
    removedFromConsent: 'Removed from Consent for Separate Vote',
    continuances: 'Continuances & Removals',
    otherChanges: 'Other Changes',
};

/** First ~max chars of a description, cut at a word boundary. */
function truncateTitle(text, max) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max - 1);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[\s\-–—:;,.]+$/, '') + '…';
}

function renderAddendumSection(addenda, anchorId) {
    const sections = { walkons: [], removedFromConsent: [], continuances: [], otherChanges: [] };
    for (const addendum of addenda) {
        for (const item of addendum.agendaItems || []) {
            const key = item.addendumSection || 'otherChanges';
            if (sections[key]) sections[key].push(item);
        }
    }
    if (!Object.values(sections).some(arr => arr.length)) return '';

    const parts = [];
    parts.push(`<section class="agenda__addendum" id="${anchorId}">`);
    parts.push('<h2>Addendum</h2>');
    parts.push('<p><em>Items below were received after the final agenda was published.</em></p>');

    for (const [key, items] of Object.entries(sections)) {
        if (!items.length) continue;
        parts.push(`<h3>${ADDENDUM_LABELS[key]}</h3>`);
        parts.push('<ul>');
        for (const item of items) {
            const rawText = item.rawTitle || item.title || '';
            // Same cleaning as the main agenda, but the digest leads with the
            // item link and the memo (the actual change) rather than the
            // full re-stated item title. Walk-ons have no main-agenda item
            // to point at, so they keep the full cleaned description.
            const fileNumber = leadingFileNumber(rawText) || item.fileNumber;
            const description = itemDescription({ rawTitle: rawText, fileNumber });
            const notes = extractTransmittalNotes(rawText);
            const isExisting = item.number != null && key !== 'walkons';
            let li;
            if (isExisting) {
                const label = `Item ${item.number}${fileNumber ? ` — ${escapeHtml(fileNumber)}` : ''}`;
                const linked = item.agendaItemId ? `<a href="#item-${item.agendaItemId}">${label}</a>` : label;
                const short = truncateTitle(description, 90);
                li = `<p><strong>${linked}</strong>${short ? ` · <span class="agenda__changes-title">${escapeHtml(short)}</span>` : ''}</p>`;
                if (notes.length) {
                    li += notes.map(n => `\n<p class="agenda__addendum-note">${escapeHtml(n)}</p>`).join('');
                } else if (!short) {
                    li += `\n<p>${escapeHtml(description)}</p>`;
                }
            } else {
                li = `<p>${escapeHtml(description)}</p>`;
                if (notes.length) li += notes.map(n => `\n<p class="agenda__addendum-note">${escapeHtml(n)}</p>`).join('');
            }
            if (item.continuedToDate) {
                li += `\n<p class="agenda__addendum-continued">⚠️ <strong>Continued to ${escapeHtml(item.continuedToDate)}</strong></p>`;
            }
            const docs = item.supportingDocuments || [];
            if (docs.length) {
                const docLis = docs.map(doc =>
                    `<li><a href="${escapeHtml(docHref(doc))}" target="_blank" rel="noopener noreferrer">${escapeHtml(doc.title || doc.originalText || 'Document')}</a></li>`
                ).join('\n');
                li += `\n<ul>\n${docLis}\n</ul>`;
            }
            parts.push(`<li>\n${li}\n</li>`);
        }
        parts.push('</ul>');
    }

    parts.push('</section>');
    return parts.join('\n');
}

// ------------------------------------------------------------------
// Per-meeting body
// ------------------------------------------------------------------

const SESSION_LABELS = {
    evening: 'Evening Agenda',
    cra: 'CRA Agenda',
    workshop: 'Workshop Agenda',
    special: 'Special Call Agenda',
};

function sessionLabel(meeting) {
    // "Special Call" alone hides what was specially called (a CRA special
    // call and a council special call both carry meetingType 'special'), so
    // prefer the clerk's own name there when the scraper captured it.
    const type = (meeting.meetingType || '').toLowerCase();
    if (type === 'special' && meeting.meetingName) return `${meeting.meetingName} Agenda`;
    return SESSION_LABELS[type] || 'Additional Agenda';
}

/**
 * Render one meeting's blocks (source link, changes, sections + items,
 * addendum). Returns { blocks, hasMap }.
 */
function renderMeeting(meeting, addenda, opts) {
    const blocks = [];
    const usedSectionIds = opts.usedSectionIds;

    // Addendum lookups (same rules as the WP emitter: walk-ons never flag
    // main-agenda items).
    const continuedItems = new Map();
    const updatedItemNums = new Set();
    for (const addendum of addenda) {
        for (const item of addendum.agendaItems || []) {
            if (item.continuedToDate) continuedItems.set(item.number, item.continuedToDate);
            else if (item.addendumSection && item.addendumSection !== 'walkons') updatedItemNums.add(item.number);
        }
    }

    const agendaTypeLabel = meeting.agendaType === 'FINAL' ? 'Final' : 'Draft';
    // The doc icon rides with the link (WP-era coblocks "page" icon treatment);
    // tm-static's FA transform swaps the <i> for a build-time sprite svg.
    blocks.push(`<p class="agenda__source"><i class="agenda__source-icon fa-solid fa-file-lines"></i> <a href="${escapeHtml(onbaseMeetingUrl(meeting.sourceUrl))}">City Clerk's ${agendaTypeLabel} Agenda in Onbase</a></p>`);

    const addendumAnchor = opts.addendumAnchor;
    if (addenda.length) {
        blocks.push(`<p class="agenda__notice">📋 <strong>Addendum available.</strong> Changes were received after this agenda was published. <a href="#${addendumAnchor}">Jump to addendum ↓</a></p>`);
    }

    // What's changed
    let changeLog = null;
    try {
        changeLog = loadChangeLog(meeting.meetingId, meeting.formattedDate);
    } catch { /* non-fatal */ }
    const changes = renderChangesSection(changeLog, meeting);
    if (changes) blocks.push(changes);

    // Funding manifest for the Item details drawers
    const fundingManifest = loadFundingManifest(meeting.meetingId, meeting.formattedDate);
    const itemIndex = new Map();
    const ctx = {
        meetingId: meeting.meetingId,
        fundingByItemId: buildFundingByItemId(fundingManifest),
        newDocKeys: collectNewDocKeys(changeLog),
        continuedItems,
        updatedItemNums,
        addendumAnchor,
        itemIndex,
    };

    // Sections of items (committee-report runs grouped under Consent Agenda)
    const mapData = collectMapData(meeting.agendaItems || []);
    const groups = groupConsentSections(
        groupItemsBySection(meeting.agendaItems || [], opts.fallbackSectionTitle)
    );
    const claimId = (title, fallback) => {
        let id = slugify(title) || fallback;
        while (usedSectionIds.has(id)) id = `${id}-2`;
        usedSectionIds.add(id);
        return id;
    };
    for (const group of groups) {
        // On multi-meeting days the fallback section title IS the session
        // label the caller already emitted as an <h2 class="agenda__session-
        // heading"> — repeating it here duplicated both heading and id.
        const inner = [];
        let section = null;
        if (!(group.isFallback && opts.suppressFallbackHeading)) {
            const id = claimId(group.title, 'agenda');
            inner.push(`<h2 id="${id}">${escapeHtml(group.title)}</h2>`);
            section = { id, title: group.title };
        }
        const subgroups = group.subgroups || [{ title: null, items: group.items }];
        for (const sub of subgroups) {
            if (sub.title) {
                inner.push(`<h3 class="agenda__committee" id="${claimId(sub.title, 'committee')}">${escapeHtml(sub.title)}</h3>`);
            }
            for (const item of sub.items) {
                if (mapData && item.agendaItemId === mapData.firstMappedItemId) {
                    inner.push(mapData.html);
                }
                inner.push(renderItem(item, ctx));
                const entry = itemIndex.get(String(item.number));
                if (entry) entry.section = section;
            }
        }
        blocks.push(`<section class="agenda__section">\n${inner.join('\n')}\n</section>`);
    }

    if (addenda.length) {
        const addendumSection = renderAddendumSection(addenda, addendumAnchor);
        if (addendumSection) blocks.push(addendumSection);
    }

    return { blocks, hasMap: Boolean(mapData), itemIndex };
}

// ------------------------------------------------------------------
// Featured item(s) — the preamble card
// ------------------------------------------------------------------

// `--feature` tokens: "80" (first/morning session) or "evening:3" /
// "morning:80" (session-qualified — item numbers restart per session).
function parseFeatureToken(token) {
    const m = String(token).trim().match(/^(?:(morning|evening):)?(\d+)$/i);
    if (!m) return null;
    return { session: (m[1] || 'morning').toLowerCase(), number: m[2] };
}

/**
 * Resolve feature tokens against the rendered sessions. Returns the matched
 * entries (with their normalized token) and warns on misses.
 */
function resolveFeatured(tokens, meetingBlocks, multi) {
    const out = [];
    for (const raw of tokens) {
        const t = parseFeatureToken(raw);
        if (!t) { console.warn(`⚠️  --feature "${raw}": expected <n> or morning:<n> / evening:<n>`); continue; }
        const idx = t.session === 'evening' ? 1 : 0;
        const mb = meetingBlocks[idx];
        const entry = mb && mb.itemIndex.get(t.number);
        if (!entry) { console.warn(`⚠️  --feature "${raw}": no item ${t.number} in the ${t.session} session`); continue; }
        const token = multi ? `${t.session}:${t.number}` : t.number;
        if (out.some(f => f.token === token)) continue;
        out.push({ ...entry, token, sessionLabel: multi ? mb.label : null });
    }
    return out;
}

/**
 * The featured card: a preamble <aside> (no h2 — tm-static's sponsor split
 * cuts before the first h2) listing the items an editor flagged with
 * --feature, each with the number chip, file number, where-it-sits line,
 * the description, and a jump link.
 */
function renderFeatured(featured) {
    if (!featured.length) return '';
    const label = featured.length === 1 ? 'Featured item' : 'Featured items';
    const items = featured.map(f => {
        const where = [];
        if (f.sessionLabel) where.push(escapeHtml(f.sessionLabel));
        if (f.section) where.push(`<a href="#${f.section.id}">${escapeHtml(f.section.title)}</a>`);
        const whereHtml = where.length ? ` <span class="agenda__featured-where">${where.join(' · ')}</span>` : '';
        const desc = f.description ? `\n<p class="agenda__featured-desc">${escapeHtml(f.description)}</p>` : '';
        return `<li class="agenda__featured-item">
<p class="agenda__featured-head"><a class="agenda-item__anchor" href="#${f.anchorId}">${f.number}</a> <span class="agenda__featured-file">${f.headLabel}</span>${whereHtml}</p>${desc}
<p class="agenda__featured-jump"><a href="#${f.anchorId}">Jump to item ${f.number} ↓</a></p>
</li>`;
    });
    return `<aside class="agenda__featured" aria-labelledby="featured-items">
<p class="agenda__featured-label" id="featured-items"><i class="agenda__featured-icon fa-solid fa-star"></i> ${label}</p>
<ul class="agenda__featured-list">
${items.join('\n')}
</ul>
</aside>`;
}

// ------------------------------------------------------------------
// Front matter + document assembly
// ------------------------------------------------------------------

// Established archive vocabulary (matches years of WP-era agenda slugs:
// regular-meeting, cra-evening-land-use, workshop-evening-land-use) — not
// the raw OnBase meeting-type names.
const TYPE_TITLES = {
    regular: { title: 'Regular Meeting', slug: 'regular-meeting' },
    evening: { title: 'Evening Land Use', slug: 'evening-land-use' },
    cra: { title: 'CRA', slug: 'cra' },
    workshop: { title: 'Workshop', slug: 'workshop' },
    special: { title: 'Special Call', slug: 'special-call' },
};

// The weekly types keep the archive vocabulary; 'special' is too generic to
// stand alone, so it takes the clerk's name ("CRA Special Call") when the
// scraper captured one (meetingName — absent on pre-2026-08 scrapes).
function typeInfo(meeting) {
    const type = (meeting.meetingType || '').toLowerCase();
    if (type === 'special' && meeting.meetingName) {
        return { title: meeting.meetingName, slug: slugify(meeting.meetingName) };
    }
    return TYPE_TITLES[type] || { title: 'Meeting', slug: 'meeting' };
}

/** "2026-07-23" → "7-23-26" (slug date token used by existing posts). */
function shortDateToken(formattedDate) {
    const [y, m, d] = formattedDate.split('-').map(Number);
    return `${m}-${d}-${String(y).slice(2)}`;
}

/** "2026-07-23" → "7/23/26" (display date for standardized titles). */
function slashDateToken(formattedDate) {
    const [y, m, d] = formattedDate.split('-').map(Number);
    return `${m}/${d}/${String(y).slice(2)}`;
}

/** Local ISO timestamp with UTC offset, e.g. 2026-07-17T09:12:00-04:00. */
function isoLocal(now = new Date()) {
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    const off = -now.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
        `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

function buildFrontMatter({ title, slug, dateIso, excerpt, hasMap, meetingDate, featuredItems }) {
    // No featuredImage: that was a WP-era requirement (hidden on the page via
    // hideFeaturedImage); tm-static renders agenda posts fine without one.
    // Note it also fed og:image — share cards have no image until tm-static
    // grows a site-level fallback.
    const lines = [
        '---',
        `title: "${title}"`,
        `date: ${dateIso}`,
        `slug: "${slug}"`,
        `excerpt: "${excerpt}"`,
        'layout: post',
        `permalink: "/tampa-city-council/agendas/${slug}/"`,
        'author: "michaelb"',
    ];
    if (hasMap) lines.push('hasMap: true');
    lines.push(`meetingDate: "${meetingDate}"`);
    // Editor's featured item(s) — kept so addendum re-runs don't drop them.
    if (featuredItems && featuredItems.length) {
        lines.push(`featuredItems: [${featuredItems.map(t => `"${t}"`).join(', ')}]`);
    }
    lines.push('categories:', '  - name: "Agendas"', '    slug: "agendas"', '    parent: true');
    lines.push('---');
    return lines.join('\n');
}

function generateMarkdownPost(meetings, options = {}) {
    const usableMeetings = meetings.filter(m => {
        const isStub = !m.sourceUrl || !(m.agendaItems && m.agendaItems.length);
        if (isStub) console.log(`⚠️  Skipping meeting ${m.meetingId} (${m.meetingType}) — no sourceUrl/agenda items yet (stub)`);
        return !isStub;
    });

    const mainMeetings = usableMeetings.filter(m => !m.isAddendum);
    const addendumMeetings = usableMeetings.filter(m => m.isAddendum);
    if (!mainMeetings.length) {
        console.error('No non-addendum meetings to process');
        return null;
    }

    const primary = mainMeetings[0];
    const meetingDate = primary.formattedDate;
    const dateToken = shortDateToken(meetingDate);
    const multi = mainMeetings.length > 1;

    // Title/slug from the meeting date + the set of meeting types on the
    // day: "7/23/26 - CRA & Evening Land Use" → 7-23-26-cra-evening-land-use.
    // The slug leads with the meeting date (weekly meetings share type names);
    // the tm-static filename is <year>/<slug>.md (fileStem kept only to
    // recognize pre-reorg date-prefixed files on re-runs).
    const infos = mainMeetings.map(typeInfo);
    const title = options.title || `${slashDateToken(meetingDate)} - ${infos.map(i => i.title).join(' & ')}`;
    const slug = options.slug || `${dateToken}-${infos.map(i => i.slug).join('-')}`;
    const fileStem = `${meetingDate}-${infos.map(i => i.slug).join('-')}`;
    // Slug as computed before meetingName existed (enum labels only), so a
    // re-run can find a post written by the older emitter instead of
    // creating a second file beside it.
    const legacySlug = `${dateToken}-${mainMeetings.map(m => typeInfo({ meetingType: m.meetingType }).slug).join('-')}`;

    const usedSectionIds = new Set();
    // Session anchors are emitted by the output loop below — reserve them so
    // a scraped section can never claim the same id.
    if (multi) {
        usedSectionIds.add('morning-agenda');
        usedSectionIds.add('evening-agenda');
    }
    usedSectionIds.add('featured-items');
    const allBlocks = [];
    let hasMap = false;

    const meetingBlocks = [];
    mainMeetings.forEach((meeting, idx) => {
        const addenda = addendumMeetings.filter(a => a.meetingType === meeting.meetingType);
        const addendumAnchor = idx === 0 ? 'addendum' : `addendum-${idx + 1}`;
        const fallbackSectionTitle = multi
            ? (idx === 0 ? 'Morning Agenda' : sessionLabel(meeting))
            : 'Agenda';
        const rendered = renderMeeting(meeting, addenda, { usedSectionIds, addendumAnchor, fallbackSectionTitle, suppressFallbackHeading: multi });
        hasMap = hasMap || rendered.hasMap;
        const label = idx === 0 ? 'Morning Agenda' : sessionLabel(meeting);
        meetingBlocks.push({ meeting, idx, label, blocks: rendered.blocks, itemIndex: rendered.itemIndex });
    });

    // Preamble: intro paragraph(s) only — tm-static splits the post before
    // the first <h2> to insert the sponsor unit, so everything above the
    // first section must be interruption-safe.
    const agendaTypeLower = primary.agendaType === 'FINAL' ? 'final' : 'draft';
    const mapSentence = hasMap ? ' Also included is a zoning map with current applications.' : '';
    allBlocks.push(
        `<p>This is a reimagined version of the Tampa City Council agenda. It removes legalese from the descriptions, parses Background details from the Summary Sheet when available, and links to supporting documents.${mapSentence} Document links point to our mirrored copies for long-term stability. For original documents, refer to the official ${agendaTypeLower} agenda from the clerk in Onbase.</p>`
    );

    // Featured item(s) sit above the quick-nav: the one thing most readers
    // came for, findable before they scroll.
    const featured = resolveFeatured(options.featured || [], meetingBlocks, multi);
    const featuredHtml = renderFeatured(featured);
    if (featuredHtml) allBlocks.push(featuredHtml);

    if (multi) {
        const secondaryLabel = sessionLabel(mainMeetings[1]);
        // A real <nav> of pill links (no text separators — tm-static styles
        // the links as pills with flex gap).
        allBlocks.push(`<nav class="agenda__nav" aria-label="Agenda sessions"><span class="agenda__nav-label">Quick navigation</span> <a class="agenda__nav-link" href="#morning-agenda">Morning Agenda</a> <a class="agenda__nav-link" href="#evening-agenda">${escapeHtml(secondaryLabel)}</a></nav>`);
    }

    for (const { meeting, idx, blocks } of meetingBlocks) {
        if (multi) {
            const label = idx === 0 ? 'Morning Agenda' : sessionLabel(meeting);
            const id = idx === 0 ? 'morning-agenda' : 'evening-agenda';
            allBlocks.push(`<h2 id="${id}" class="agenda__session-heading">${label}</h2>`);
        }
        allBlocks.push(...blocks);
    }

    const excerpt = hasMap
        ? 'A reimagined version of the Tampa City Council agenda including mirrored supporting documents and interactive zoning map of land use items.'
        : 'A reimagined version of the Tampa City Council agenda including mirrored supporting documents.';

    const body = allBlocks.map(tightBlock).filter(Boolean).join('\n\n');
    const featuredItems = featured.map(f => f.token);
    return { title, slug, legacySlug, fileStem, meetingDate, excerpt, hasMap, featuredItems, body };
}

// ------------------------------------------------------------------
// Output
// ------------------------------------------------------------------

/**
 * Write the post. Always writes the pipeline record copy; when destDir is
 * set, writes/updates the tm-static post — an existing post with the same
 * slug keeps its filename and original front-matter date.
 */
function writePost(post, destDir) {
    const dateIso = isoLocal();
    let frontMatter = buildFrontMatter({ ...post, dateIso });

    const recordPath = path.join(RECORD_DIR, `agenda_${post.meetingDate}.md`);
    fs.writeFileSync(recordPath, `${frontMatter}\n\n${post.body}\n`);
    console.log(`📝 Markdown record: ${recordPath}`);

    if (!destDir) return;

    if (!fs.existsSync(destDir)) {
        console.error(`❌ Destination directory not found: ${destDir}`);
        return;
    }

    // tm-static posts nest by year with slug-only filenames
    // (src/posts/<year>/<slug>.md, reorg 2026-08) — the slug already leads
    // with the short meeting-date token, so weekly type-name repeats can't
    // collide within a year.
    const yearDir = path.join(destDir, post.meetingDate.slice(0, 4));
    fs.mkdirSync(yearDir, { recursive: true });

    let destPath = findExistingPost(destDir, post);
    if (destPath) {
        // Keep the original publish date and slug/permalink on re-runs — the
        // URL may already be live (and may have been set with --slug). Delete
        // the file first if you really want a fresh slug.
        const prev = fs.readFileSync(destPath, 'utf8');
        const prevDate = prev.match(/^date:\s*(.+)$/m);
        const prevSlug = prev.match(/^slug:\s*"?([^"\n]+)"?\s*$/m);
        const keep = {};
        if (prevDate) keep.dateIso = prevDate[1].trim();
        if (prevSlug && prevSlug[1].trim() !== post.slug) {
            keep.slug = prevSlug[1].trim();
            console.log(`   Keeping existing slug "${keep.slug}" (computed: "${post.slug}")`);
        }
        frontMatter = buildFrontMatter({ ...post, ...keep, dateIso: keep.dateIso || dateIso });
        console.log(`♻️  Updating existing post: ${destPath}`);
    } else {
        destPath = path.join(yearDir, `${post.slug}.md`);
        console.log(`✨ New post: ${destPath}`);
    }
    fs.writeFileSync(destPath, `${frontMatter}\n\n${post.body}\n`);
}

/** Path of the tm-static post this meeting already has (slug-matched), or null. */
function findExistingPost(destDir, post) {
    const yearDir = path.join(destDir, post.meetingDate.slice(0, 4));
    if (!fs.existsSync(yearDir)) return null;
    const slugs = [post.slug, post.legacySlug].filter(Boolean);
    const existing = fs.readdirSync(yearDir).find(f =>
        f === `${post.fileStem}.md` || slugs.some(s => f === `${s}.md` || f.endsWith(`-${s}.md`)));
    return existing ? path.join(yearDir, existing) : null;
}

/** `featuredItems: ["80", "evening:1"]` from an existing post's front matter. */
function readFeaturedItems(postPath) {
    const src = fs.readFileSync(postPath, 'utf8');
    const m = src.match(/^featuredItems:\s*\[(.*)\]\s*$/m);
    if (!m) return [];
    return m[1].split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

function parseArguments() {
    const args = process.argv.slice(2);
    const options = { meetingIds: [], date: null, dest: undefined, slug: null, title: null, featured: [], clearFeatured: false, help: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--date' || arg === '-d') options.date = args[++i];
        else if (arg === '--dest') options.dest = args[++i];
        else if (arg === '--slug') options.slug = args[++i];
        else if (arg === '--title') options.title = args[++i];
        else if (arg === '--feature' || arg === '-f') {
            const val = args[++i] || '';
            if (val.toLowerCase() === 'none') options.clearFeatured = true;
            else options.featured.push(...val.split(',').map(t => t.trim()).filter(Boolean));
        }
        else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) options.date = arg;
        else if (/^\d+$/.test(arg)) options.meetingIds.push(arg);
    }
    return options;
}

function showHelp() {
    console.log(`
JSON to Markdown post converter (tm-static)

Usage:
  node json-to-markdown.js --date YYYY-MM-DD [options]
  node json-to-markdown.js <meetingId> [<meetingId> ...] [options]

Options:
  -d, --date YYYY-MM-DD   Convert all meetings for a date (addenda auto-load)
      --dest <dir>        tm-static posts dir (default: $TM_STATIC_POSTS_DIR)
      --slug <slug>       Override the generated post slug
      --title <title>     Override the generated post title
  -f, --feature <item>    Feature an item in the preamble card: "80", or
                          "evening:3" on two-session days (repeatable, or
                          comma-separated). Kept across re-runs via the
                          post's featuredItems front matter; --feature none
                          clears it.
  -h, --help              Show this help

Always writes agendas/agenda_<date>.md; also writes/updates the tm-static
post when a destination is set. Existing posts (matched on slug) keep their
filename and original front-matter date.
`);
}

function main() {
    const options = parseArguments();
    if (options.help) {
        showHelp();
        return;
    }
    if (!options.meetingIds.length && !options.date) {
        console.error('Error: pass a date (--date YYYY-MM-DD) or meeting ID(s). Use --help for usage.');
        process.exit(1);
    }

    const meetings = loadMeetings(options);
    if (!meetings.length) {
        console.error('No meetings found to process');
        process.exit(1);
    }

    let post = generateMarkdownPost(meetings, options);
    if (!post) process.exit(1);

    const destDir = options.dest !== undefined ? options.dest : (process.env.TM_STATIC_POSTS_DIR || null);

    // Re-runs (addenda, re-scrapes) keep the editor's featured item(s)
    // unless this run names its own or clears them.
    if (destDir && !options.featured.length && !options.clearFeatured) {
        const existing = findExistingPost(destDir, post);
        const kept = existing ? readFeaturedItems(existing) : [];
        if (kept.length) {
            console.log(`⭐ Keeping featured item(s) from existing post: ${kept.join(', ')}`);
            post = generateMarkdownPost(meetings, { ...options, featured: kept });
        }
    }
    writePost(post, destDir);

    const itemCount = meetings.reduce((n, m) => n + (m.agendaItems?.length || 0), 0);
    console.log(`Processed ${meetings.length} meeting(s), ${itemCount} agenda items → ${post.slug}`);
}

if (require.main === module) {
    main();
}

module.exports = {
    generateMarkdownPost,
    writePost,
    normalizeSectionTitle,
    groupItemsBySection,
    groupConsentSections,
    renderChangesSection,
    collectMapData,
};

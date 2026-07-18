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
 *   node json-to-markdown.js --date 2026-07-23 --dest ~/Sites/tm-static/src/posts
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
            const text = cleanAgendaContent(rawText).replace(/\*\*([^*]+)\*\*/g, '$1').trim();
            let li = `<p>${escapeHtml(text)}</p>`;
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
    return SESSION_LABELS[(meeting.meetingType || '').toLowerCase()] || 'Additional Agenda';
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
    const ctx = {
        meetingId: meeting.meetingId,
        fundingByItemId: buildFundingByItemId(fundingManifest),
        newDocKeys: collectNewDocKeys(changeLog),
        continuedItems,
        updatedItemNums,
        addendumAnchor,
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
        if (!(group.isFallback && opts.suppressFallbackHeading)) {
            const id = claimId(group.title, 'agenda');
            inner.push(`<h2 id="${id}">${escapeHtml(group.title)}</h2>`);
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
            }
        }
        blocks.push(`<section class="agenda__section">\n${inner.join('\n')}\n</section>`);
    }

    if (addenda.length) {
        const addendumSection = renderAddendumSection(addenda, addendumAnchor);
        if (addendumSection) blocks.push(addendumSection);
    }

    return { blocks, hasMap: Boolean(mapData) };
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

function typeInfo(meetingType) {
    return TYPE_TITLES[(meetingType || '').toLowerCase()] || { title: 'Meeting', slug: 'meeting' };
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

function buildFrontMatter({ title, slug, dateIso, excerpt, hasMap, meetingDate }) {
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
    // the tm-static filename is the ISO meeting date + type slugs (no date
    // token twice, and never the generation date).
    const infos = mainMeetings.map(m => typeInfo(m.meetingType));
    const title = options.title || `${slashDateToken(meetingDate)} - ${infos.map(i => i.title).join(' & ')}`;
    const slug = options.slug || `${dateToken}-${infos.map(i => i.slug).join('-')}`;
    const fileStem = `${meetingDate}-${infos.map(i => i.slug).join('-')}`;

    const usedSectionIds = new Set();
    // Session anchors are emitted by the output loop below — reserve them so
    // a scraped section can never claim the same id.
    if (multi) {
        usedSectionIds.add('morning-agenda');
        usedSectionIds.add('evening-agenda');
    }
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
        meetingBlocks.push({ meeting, idx, blocks: rendered.blocks });
    });

    // Preamble: intro paragraph(s) only — tm-static splits the post before
    // the first <h2> to insert the sponsor unit, so everything above the
    // first section must be interruption-safe.
    const agendaTypeLower = primary.agendaType === 'FINAL' ? 'final' : 'draft';
    const mapSentence = hasMap ? ' Also included is a zoning map with current applications.' : '';
    allBlocks.push(
        `<p>This is a reimagined version of the Tampa City Council agenda. It removes legalese from the descriptions, parses Background details from the Summary Sheet when available, and links to supporting documents.${mapSentence} Document links point to our mirrored copies for long-term stability. For original documents, refer to the official ${agendaTypeLower} agenda from the clerk in Onbase.</p>`
    );

    if (multi) {
        const secondaryLabel = sessionLabel(mainMeetings[1]);
        allBlocks.push(`<p class="agenda__nav"><strong>Quick navigation:</strong> <a href="#morning-agenda">Morning Agenda</a> · <a href="#evening-agenda">${secondaryLabel}</a></p>`);
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
    return { title, slug, fileStem, meetingDate, excerpt, hasMap, body };
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

    const existing = fs.readdirSync(destDir).find(f =>
        f === `${post.fileStem}.md` || f.endsWith(`-${post.slug}.md`));
    let destPath;
    if (existing) {
        destPath = path.join(destDir, existing);
        // Keep the original publish date on re-runs.
        const prev = fs.readFileSync(destPath, 'utf8');
        const prevDate = prev.match(/^date:\s*(.+)$/m);
        if (prevDate) {
            frontMatter = buildFrontMatter({ ...post, dateIso: prevDate[1].trim() });
        }
        console.log(`♻️  Updating existing post: ${destPath}`);
    } else {
        destPath = path.join(destDir, `${post.fileStem}.md`);
        console.log(`✨ New post: ${destPath}`);
    }
    fs.writeFileSync(destPath, `${frontMatter}\n\n${post.body}\n`);
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

function parseArguments() {
    const args = process.argv.slice(2);
    const options = { meetingIds: [], date: null, dest: undefined, slug: null, title: null, help: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--date' || arg === '-d') options.date = args[++i];
        else if (arg === '--dest') options.dest = args[++i];
        else if (arg === '--slug') options.slug = args[++i];
        else if (arg === '--title') options.title = args[++i];
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

    const post = generateMarkdownPost(meetings, options);
    if (!post) process.exit(1);

    const destDir = options.dest !== undefined ? options.dest : (process.env.TM_STATIC_POSTS_DIR || null);
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

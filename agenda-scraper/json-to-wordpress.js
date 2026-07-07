const fs = require('fs');
const path = require('path');
require('dotenv').config();

const {
    loadFundingManifest,
    buildFundingByItemId,
    renderItemFinancialSection,
} = require('./lib/render-funding');
const { loadChangeLog } = require('./lib/change-log');
// Top-of-agenda summary card is intentionally disabled.
const renderAgendaFundingOverview = () => '';

/**
 * Extract date from agenda filename
 * @param {string} filename - The filename to extract date from
 * @returns {string|null} - Date in YYYY-MM-DD format or null if not found
 */
function extractDateFromFilename(filename) {
    const match = filename.match(/agenda_\d+_(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

/**
 * Find existing WordPress file for the same date
 * @param {string} meetingId - Current meeting ID
 * @param {string} meetingDateStr - Meeting date string
 * @returns {string|null} - Path to existing file or null if not found
 */
function findExistingWordPressFileForDate(meetingId, meetingDateStr) {
    const outputDir = path.join(__dirname, 'agendas');
    
    if (!meetingDateStr) return null;
    
    try {
        const files = fs.readdirSync(outputDir);
        const wpFiles = files.filter(file => file.endsWith('.wp.html'));
        
        for (const file of wpFiles) {
            // Check for direct date-based naming (new format)
            if (file === `agenda_${meetingDateStr}.wp.html`) {
                return path.join(outputDir, file);
            }
            
            // Also check old format with date suffix for backward compatibility
            const fileDate = extractDateFromFilename(file);
            if (fileDate === meetingDateStr) {
                // Make sure it's not the same meeting ID
                const fileMeetingId = file.match(/agenda_(\d+)/)?.[1];
                if (fileMeetingId !== meetingId) {
                    return path.join(outputDir, file);
                }
            }
        }
    } catch (error) {
        console.error('Error reading agenda directory:', error);
    }
    
    return null;
}

/**
 * Format text content that may contain WordPress blocks.
 * Separates plain text (which needs <p> wrapping) from WordPress blocks (which don't).
 * @param {string} text - Text that may contain <!-- wp: --> blocks
 * @returns {string} - Properly formatted content
 */
function formatTextWithBlocks(text) {
    if (!text || text.trim().length === 0) {
        return '';
    }
    
    // Check if text contains WordPress blocks
    const wpBlockStart = text.indexOf('<!-- wp:');
    
    if (wpBlockStart === -1) {
        // No blocks, just wrap in paragraph
        return `<p>${text}</p>`;
    }
    
    // Split into plain text and block content
    const plainText = text.substring(0, wpBlockStart).trim();
    const blockContent = text.substring(wpBlockStart);
    
    let result = '';
    if (plainText) {
        result += `<p>${plainText}</p>`;
    }
    // Append block content without wrapping (it's already properly formatted)
    result += blockContent;
    
    return result;
}


// Since formatBackgroundForWordPress and cleanAgendaContent might not be exported,
// let's implement them locally for now
function formatBackgroundForWordPress(backgroundText) {
    if (!backgroundText || backgroundText.trim().length === 0) {
        return '';
    }
    
    // Split by double line breaks (which should separate numbered items after our formatting)
    const sections = backgroundText.split(/\n\s*\n/).filter(section => section.trim().length > 0);
    
    let formattedContent = '';
    let listItems = [];
    let regularParagraphs = [];
    
    sections.forEach(section => {
        const trimmedSection = section.trim();
        
        // Check if this looks like a numbered item
        if (trimmedSection.match(/^\d+\.\s/)) {
            // Remove the number and period, keep the rest
            const itemText = trimmedSection.replace(/^\d+\.\s*/, '');
            listItems.push(itemText);
        } else {
            // Regular paragraph
            regularParagraphs.push(trimmedSection);
        }
    });
    
    // Add ordered list if we have numbered items
    if (listItems.length > 0) {
        formattedContent += `\n<!-- wp:list {"ordered":true} -->\n<ol>`;
        listItems.forEach(item => {
            formattedContent += `\n<!-- wp:list-item -->\n<li>${item}</li>\n<!-- /wp:list-item -->`;
        });
        formattedContent += `\n</ol>\n<!-- /wp:list -->`;
    }
    
    // Add regular paragraphs
    regularParagraphs.forEach(paragraph => {
        formattedContent += `\n<!-- wp:paragraph -->
<p>${paragraph}</p>
<!-- /wp:paragraph -->`;
    });
    
    // If no structured content was found, treat as single paragraph
    if (formattedContent.trim().length === 0) {
        formattedContent = `\n<!-- wp:paragraph -->
<p>${backgroundText.replace(/\n/g, ' ').trim()}</p>
<!-- /wp:paragraph -->`;
    }
    
    return formattedContent;
}

function cleanAgendaContent(content) {
    // Strip a memo/email transmission sentence unless it requests a
    // continuance (e.g. "requesting that said agenda item be continued to
    // July 23, 2026") — those memos carry real scheduling information.
    const stripUnlessContinuance = (match) => /continu/i.test(match) ? match : ' ';

    // First preserve file numbers with proper formatting
    let cleaned = content
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
 * Parse command line arguments
 * @returns {Object} - Parsed arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        meetingIds: [],
        date: null,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--date' || arg === '-d') {
            options.date = args[++i];
        } else if (arg === '--meetings' || arg === '-m') {
            // Parse comma-separated meeting IDs
            const meetingIdString = args[++i];
            options.meetingIds = meetingIdString.split(',').map(id => id.trim());
        } else if (arg.match(/^\d{4}-\d{2}-\d{2}$/)) {
            // Assume it's a date if it matches YYYY-MM-DD format
            options.date = arg;
        } else if (arg.match(/^\d+$/)) {
            // Assume it's a meeting ID if it's just numbers
            options.meetingIds.push(arg);
        }
    }

    return options;
}

/**
 * Show help information
 */
function showHelp() {
    console.log(`
JSON to WordPress Block Markup Converter

Usage:
  node json-to-wordpress.js [options]

Options:
  -h, --help                    Show this help message
  -d, --date YYYY-MM-DD        Convert all meetings for a specific date
  -m, --meetings ID1,ID2,...   Convert specific meeting IDs (comma-separated)
  
Examples:
  node json-to-wordpress.js 2634                    # Convert meeting 2634
  node json-to-wordpress.js 2634,2589               # Convert meetings 2634 and 2589
  node json-to-wordpress.js --date 2025-07-31       # Convert all meetings on July 31, 2025
  node json-to-wordpress.js -m 2634,2589            # Convert meetings 2634 and 2589
`);
}

/**
 * Find JSON files for a given date
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Array} - Array of JSON file paths
 */
function findJSONFilesForDate(date) {
    const dataDir = path.join(__dirname, 'data');
    const files = [];
    
    try {
        const dirFiles = fs.readdirSync(dataDir);
        const jsonFiles = dirFiles.filter(file => file.endsWith('.json') && file.includes(date));
        
        for (const file of jsonFiles) {
            files.push(path.join(dataDir, file));
        }
    } catch (error) {
        console.error('Error reading data directory:', error);
    }
    
    return files;
}

/**
 * Load JSON data from file
 * @param {string} filePath - Path to JSON file
 * @returns {Object|null} - Parsed JSON data or null if error
 */
function loadJSONData(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`Error loading JSON file ${filePath}:`, error);
        return null;
    }
}

/**
 * Generate supporting documents markup
 * @param {Array} supportingDocuments - Array of supporting document objects
 * @returns {string} - WordPress block markup for supporting documents
 */

/**
 * Split a waiver blob ("1. foo. 2. bar. 3. baz") into individual items.
 * Splits on whitespace that precedes a cardinal number + ". " sequence, so
 * section codes like "27-284.2.5" are not treated as split points (the digit
 * there is not followed by whitespace before the period).
 */
function splitNumberedWaivers(text) {
    // Only attempt splitting when the text contains at least " 2. " (two waivers).
    if (!/\s2\.\s/.test(text)) return [text.trim()].filter(Boolean);
    return text.split(/\s+(?=\d{1,2}\.\s)/).map(s => s.trim()).filter(Boolean);
}

/**
 * Format land use staff report data as a semantic HTML section.
 *
 * Always renders when any field is present. Caller wraps in wp:html.
 * Mirrors the visual pattern of agenda-item-financial sections:
 *   <section aria-labelledby> / <dl> for facts / <ol> for ordered waivers.
 *
 * @param {object} staffReport - staffReport object from agendaItem
 * @param {string|number} agendaItemId - used for aria-labelledby
 * @returns {string} - HTML string, or empty string when nothing to render
 */
function formatStaffReportForWordPress(staffReport, agendaItemId) {
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
 * Build the unified "Item details" drawer for a single agenda item.
 *
 * Sections, in order:
 *   1. Financial impact (only when the OpenGov manifest has resolved data)
 *   2. Background narrative (when item.background is populated)
 *   3. Staff report fallback (when no background but staffReport fields exist)
 *
 * Supporting documents are intentionally NOT inside this drawer — they
 * remain a sibling block below the agenda item so links stay conspicuous.
 *
 * @param {object} item - Agenda item from the scraped meeting JSON
 * @param {object|null} fundingItem - Matching entry from the funding manifest
 * @returns {string} - WordPress block markup (empty string if no sections)
 */
function buildItemDetailsDrawer(item, fundingItem) {
    const innerBlocks = [];

    // 1. Financial impact (already a complete wp:html block)
    // Augment the manifest funding item with supporting documents from the
    // agenda item so the renderer can link to the cover sheet PDF in
    // reallocation imbalance warnings.
    const fundingItemWithDocs = fundingItem
        ? { ...fundingItem, supportingDocuments: item.supportingDocuments || [] }
        : fundingItem;
    const financial = renderItemFinancialSection(fundingItemWithDocs, item.projectedCosts);
    if (financial) innerBlocks.push(financial);

    // 2. Background narrative — emit a heading + existing wp:paragraph/wp:list
    //    blocks produced by formatBackgroundForWordPress.
    if (item.background && item.background.trim().length > 0) {
        const formattedBackground = formatBackgroundForWordPress(item.background.trim());
        innerBlocks.push(
            `<!-- wp:heading {"level":4,"className":"agenda-item-section__heading"} -->
<h4 class="wp-block-heading agenda-item-section__heading">Background</h4>
<!-- /wp:heading -->${formattedBackground}`
        );
    }

    // 3. Land use details — always rendered when staffReport data exists,
    //    independent of whether a background narrative is present.
    if (item.staffReport) {
        const formattedStaffReport = formatStaffReportForWordPress(item.staffReport, item.agendaItemId);
        if (formattedStaffReport) {
            innerBlocks.push(`<!-- wp:html -->
${formattedStaffReport}
<!-- /wp:html -->`);
        }
    }

    if (innerBlocks.length === 0) return '';

    return `\n\n<!-- wp:details -->
<details class="wp-block-details agenda-item-details"><summary>Item details</summary>
${innerBlocks.join('\n\n')}
</details>
<!-- /wp:details -->`;
}

/**
 * Generate background details block with summary/details structure
 * @param {string} background - Background text content
 * @returns {string} - WordPress block markup for background details
 */
function generateBackgroundDetailsBlock(background) {
    if (!background || background.trim() === '') {
        return '';
    }

    const cleanedBackground = cleanAgendaContent(background);
    
    return `
<!-- wp:details -->
<details class="wp-block-details"><summary>Background Details</summary><!-- wp:paragraph -->
<p>${cleanedBackground}</p>
<!-- /wp:paragraph --></details>
<!-- /wp:details -->`;
}
function generateSupportingDocsMarkup(supportingDocuments) {
    if (!supportingDocuments || supportingDocuments.length === 0) {
        return '';
    }

    let markup = `
<!-- wp:group {"className":"agenda-supporting-docs"} -->
<div class="wp-block-group agenda-supporting-docs">
<!-- wp:heading {"level":4} -->
<h4 class="wp-block-heading">Supporting Documents:</h4>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list">`;

    supportingDocuments.forEach(doc => {
        const title = doc.title || doc.originalText || 'Document';
        // Prefer mirroredUrl (from S3/R2) over original OnBase URL
        const docUrl = doc.mirroredUrl || doc.url;
        markup += `
<!-- wp:list-item -->
<li><a href="${docUrl}" target="_blank" rel="noopener noreferrer">${title}</a></li>
<!-- /wp:list-item -->`;
    });

    markup += `
</ul>
<!-- /wp:list -->
</div>
<!-- /wp:group -->`;

    return markup;
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

/**
 * Render the public-facing "What's Changed" aside block for one meeting.
 * Returns an empty string when the change log has no entries.
 *
 * @param {Object|null} changeLog  Result of loadChangeLog (may be null).
 * @param {Object}      meeting    Meeting data object (needs .meetingId).
 * @returns {string} WordPress block markup.
 */
function renderWhatsChangedBox(changeLog, meeting) {
    if (!changeLog || !changeLog.entries || changeLog.entries.length === 0) {
        return '';
    }

    const mid = meeting.meetingId;
    const headingId = `whats-changed-${mid}`;

    // Build agenda-item-number → anchor-id lookup so we can link each entry
    // back to its position in the main agenda list.
    const itemAnchorMap = new Map();
    for (const item of (meeting.agendaItems || [])) {
        if (item.number != null && item.agendaItemId != null) {
            itemAnchorMap.set(String(item.number), `item-${item.agendaItemId}`);
        }
    }

    // Shorthand: paragraph using theme preset classes so the block editor
    // renders the correct colours/size without needing custom CSS loaded.
    // textColor:"contrast" → has-contrast-color; fontSize:"small" → has-small-font-size
    const para = (content) =>
        `<!-- wp:paragraph {"textColor":"contrast","fontSize":"small"} -->\n<p class="has-contrast-color has-small-font-size">${content}</p>\n<!-- /wp:paragraph -->`;

    // textColor:"accent-3" → has-accent-3-color (teal); fontSize:"large" → has-large-font-size
    // Both are preset-based so save() emits only classes, no inline styles — validation stays clean.
    let innerBlocks = `<!-- wp:heading {"level":3,"anchor":"${headingId}","textColor":"accent-3","fontSize":"large"} -->
<h3 class="wp-block-heading has-accent-3-color has-large-font-size" id="${headingId}">What's Changed</h3>
<!-- /wp:heading -->
`;

    let hasContent = false;

    for (const entry of changeLog.entries) {
        const sections = [];

        // Draft → Final promotion
        if (entry.agendaTypePromoted && entry.agendaTypePromoted.to === 'FINAL') {
            sections.push(para('Agenda was finalized.'));
        }

        // Items added
        if (entry.itemsAdded && entry.itemsAdded.length > 0) {
            const bullets = entry.itemsAdded.map(item => {
                const anchor = item.agendaItemId ? `#item-${item.agendaItemId}` : null;
                const text = item.fileNumber ? item.fileNumber : `Item ${item.number}`;
                const linked = anchor ? `<a href="${anchor}">${text}</a>` : text;
                const label = `<strong>${linked}</strong>`;
                const title = item.shortTitle ? ` \u2014 ${item.shortTitle}` : '';
                return `<!-- wp:list-item -->\n<li>${label}${title}</li>\n<!-- /wp:list-item -->`;
            }).join('\n');
            sections.push(`${para(`Item${entry.itemsAdded.length > 1 ? 's' : ''} added:`)}\n<!-- wp:list -->\n<ul class="wp-block-list">\n${bullets}\n</ul>\n<!-- /wp:list -->`);
        }

        // Items removed
        if (entry.itemsRemoved && entry.itemsRemoved.length > 0) {
            const bullets = entry.itemsRemoved.map(item => {
                const anchor = item.agendaItemId ? `#item-${item.agendaItemId}` : null;
                const text = item.fileNumber ? item.fileNumber : `Item ${item.number}`;
                const linked = anchor ? `<a href="${anchor}">${text}</a>` : text;
                const label = `<strong>${linked}</strong>`;
                const title = item.shortTitle ? ` \u2014 ${item.shortTitle}` : '';
                return `<!-- wp:list-item -->\n<li>${label}${title}</li>\n<!-- /wp:list-item -->`;
            }).join('\n');
            sections.push(`${para(`Item${entry.itemsRemoved.length > 1 ? 's' : ''} removed:`)}\n<!-- wp:list -->\n<ul class="wp-block-list">\n${bullets}\n</ul>\n<!-- /wp:list -->`);
        }

        // Budget total changed
        if (entry.totalChanged) {
            sections.push(para(`Estimated budget impact changed from ${entry.totalChanged.from} to ${entry.totalChanged.to}.`));
        }

        // Newly mirrored documents grouped by item
        if (entry.newDocuments && entry.newDocuments.length > 0) {
            const groups = new Map();
            for (const doc of entry.newDocuments) {
                const key = `${doc.itemNumber}::${doc.itemFileNumber}`;
                if (!groups.has(key)) {
                    groups.set(key, { itemNumber: doc.itemNumber, itemFileNumber: doc.itemFileNumber, files: [] });
                }
                groups.get(key).files.push(doc.filename);
            }
            const bullets = [...groups.values()].map(g => {
                const anchor = itemAnchorMap.get(String(g.itemNumber));
                const itemText = g.itemFileNumber
                    ? `Item ${g.itemNumber} \u2014 ${g.itemFileNumber}`
                    : `Item ${g.itemNumber}`;
                const linked = anchor ? `<a href="#${anchor}">${itemText}</a>` : itemText;
                const label = `<strong>${linked}</strong>`;
                return `<!-- wp:list-item -->\n<li>${label}: ${g.files.join(', ')}</li>\n<!-- /wp:list-item -->`;
            }).join('\n');
            sections.push(`<!-- wp:group {"className":"agenda-supporting-docs"} -->\n<div class="wp-block-group agenda-supporting-docs"><!-- wp:heading {"level":4} -->\n<h4 class="wp-block-heading">New Supporting Documents:</h4>\n<!-- /wp:heading -->\n<!-- wp:list -->\n<ul class="wp-block-list">\n${bullets}\n</ul>\n<!-- /wp:list -->\n</div>\n<!-- /wp:group -->`);
        }

        if (sections.length === 0) continue;
        hasContent = true;

        const dateLabel = formatChangeLogDate(entry.date);
        innerBlocks += `${para(`<strong>${dateLabel}</strong>`)}\n${sections.join('\n')}\n`;
    }

    if (!hasContent) return '';

    // backgroundColor:"accent-5" → has-accent-5-background-color (off-white #F8F8F2,
    // same as the theme's quote block bg). Custom CSS .agenda-whats-changed adds the
    // teal left border. Block-level padding via spacing preset keeps the editor preview
    // in sync without relying on custom CSS being loaded.
    return `<!-- wp:group {"backgroundColor":"accent-5","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","right":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40"}}},"className":"agenda-whats-changed"} -->
<div class="wp-block-group agenda-whats-changed has-accent-5-background-color" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
${innerBlocks.trim()}
</div>
<!-- /wp:group -->

`;
}

/**
 * Get output filename for the generated markup
 * @param {Array} meetings - Array of meeting data objects
 * @returns {string} - Output filename
 */

/**
 * Generate complete WordPress markup from meeting data
 * @param {Array} meetings - Array of meeting data objects
 * @returns {string} - Complete WordPress block markup
 */
/**
 * Generate WordPress markup from meeting data using original logic
 * @param {Array} meetings - Array of meeting data objects
 * @returns {string} - Complete WordPress block markup
 */
function generateWordPressMarkup(meetings) {
    const outputDir = path.join(__dirname, 'agendas');
    
    // Skip stub meetings: OnBase sometimes posts a meeting shell before the
    // agenda is published, leaving no sourceUrl and no items to render.
    const usableMeetings = meetings.filter(m => {
        const isStub = !m.sourceUrl || !(m.agendaItems && m.agendaItems.length);
        if (isStub) {
            console.log(`⚠️  Skipping meeting ${m.meetingId} (${m.meetingType}) — no sourceUrl/agenda items yet (stub)`);
        }
        return !isStub;
    });

    // Separate main meetings from addendum meetings
    const nonAddendumMeetings = usableMeetings.filter(m => !m.isAddendum);
    const addendumMeetings = usableMeetings.filter(m => m.isAddendum);

    if (addendumMeetings.length > 0) {
        const label = addendumMeetings[0].formattedDate || addendumMeetings[0].meetingDate;
        console.log(`📋 Found ${addendumMeetings.length} addendum meeting(s) for ${label} — will merge into output`);
    }

    if (nonAddendumMeetings.length === 0) {
        console.log('⚠️  No non-addendum meetings to process');
        return 'No meetings to process (all were addendums)';
    }

    // For each main meeting, find addenda with matching meetingType
    function findAddendaForMeeting(mainMeeting) {
        return addendumMeetings.filter(a => a.meetingType === mainMeeting.meetingType);
    }

    const hasMultipleMeetings = nonAddendumMeetings.length > 1;

    // Derive the secondary-meeting label up-front so it can be referenced
    // both in the leading meeting's nav strip and in the heading inserted
    // when the secondary meeting is appended.
    const typeLabels = {
        evening:  'Evening Agenda',
        cra:      'CRA Agenda',
        workshop: 'Workshop Agenda',
        special:  'Special Call Agenda',
    };
    const secondaryMeeting = hasMultipleMeetings ? nonAddendumMeetings[1] : null;
    const secondaryLabel = secondaryMeeting
        ? (typeLabels[(secondaryMeeting.meetingType || '').toLowerCase()] || 'Additional Agenda')
        : 'Evening Agenda';

    // Process meetings in order, following original combination logic
    nonAddendumMeetings.forEach((meeting, meetingIndex) => {
        const addenda = findAddendaForMeeting(meeting);
        const wpHtml = generateSingleMeetingMarkup(meeting, meetingIndex > 0, hasMultipleMeetings, secondaryLabel, addenda);
        
        // Check if we should combine with existing agenda for the same date
        const existingFile = findExistingWordPressFileForDate(meeting.meetingId, meeting.formattedDate);
        
        if (existingFile && meetingIndex > 0) {
            // Read existing content and append the secondary meeting agenda.
            const existingContent = fs.readFileSync(existingFile, 'utf8');

            // The heading anchor stays `evening-agenda` for backward
            // compatibility with existing in-page links; only the visible
            // label changes per meeting type.
            let eveningContent = `<!-- wp:heading {"level":2} -->
<h2 id="evening-agenda">${secondaryLabel}</h2>
<!-- /wp:heading -->

` + wpHtml.trim();
            
            const combinedContent = existingContent + '\n\n' + eveningContent;
            fs.writeFileSync(existingFile, combinedContent);
        } else {
            // Create new file or first meeting
            const outputFileName = meeting.formattedDate ? 
                path.join(outputDir, `agenda_${meeting.formattedDate}.wp.html`) :
                path.join(outputDir, `agenda_${meeting.meetingId}.wp.html`);
            
            fs.writeFileSync(outputFileName, wpHtml);
        }
    });
    
    return 'WordPress markup generated for all meetings';
}

/**
 * Render the Addendum summary section appended at the bottom of the post.
 * Groups addendum items by their parsed section: walkons, removedFromConsent,
 * continuances, and otherChanges.
 * @param {Array} addenda - Array of addendum meeting data objects
 * @returns {string} WordPress block HTML or empty string
 */
function renderAddendumSection(addenda) {
    const sections = {
        walkons: [],
        removedFromConsent: [],
        continuances: [],
        otherChanges: [],
    };

    const sectionLabels = {
        walkons: 'Walk-on Items / New Business',
        removedFromConsent: 'Removed from Consent for Separate Vote',
        continuances: 'Continuances & Removals',
        otherChanges: 'Other Changes',
    };

    for (const addendum of addenda) {
        for (const item of (addendum.agendaItems || [])) {
            const key = item.addendumSection || 'otherChanges';
            if (sections[key]) sections[key].push(item);
        }
    }

    const hasItems = Object.values(sections).some(arr => arr.length > 0);
    if (!hasItems) return '';

    let html = `\n<!-- wp:heading {"level":3} -->
<h3 id="addendum">Addendum</h3>
<!-- /wp:heading -->

<!-- wp:group {"className":"addendum-section"} -->
<div class="wp-block-group addendum-section">
<!-- wp:paragraph -->
<p><em>Items below were received after the final agenda was published.</em></p>
<!-- /wp:paragraph -->

`;

    for (const [sectionKey, items] of Object.entries(sections)) {
        if (items.length === 0) continue;

        html += `<!-- wp:heading {"level":4} -->
<h4>${sectionLabels[sectionKey]}</h4>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list">
`;

        for (const item of items) {
            const rawText = item.rawTitle || item.title || '';
            const itemText = cleanAgendaContent(rawText).replace(/\*\*([^*]+)\*\*/g, '$1').trim();

            let liContent = `<p>${itemText}</p>`;

            if (item.continuedToDate) {
                liContent += `<p class="addendum-continued">⚠️ <strong>Continued to ${item.continuedToDate}</strong></p>`;
            }

            if (item.supportingDocuments && item.supportingDocuments.length > 0) {
                liContent += `<ul>`;
                item.supportingDocuments.forEach(doc => {
                    const docUrl = doc.mirroredUrl ||
                        (doc.url.startsWith('http') ? doc.url : 'https://tampagov.hylandcloud.com' + doc.url.replace(/&amp;/g, '&'));
                    const docText = doc.title || doc.originalText || 'Document';
                    liContent += `<li><a href="${docUrl}" target="_blank" rel="noopener noreferrer">${docText}</a></li>`;
                });
                liContent += `</ul>`;
            }

            html += `<!-- wp:list-item -->
<li>${liContent}</li>
<!-- /wp:list-item -->
`;
        }

        html += `</ul>
<!-- /wp:list -->

`;
    }

    html += `</div>
<!-- /wp:group -->
`;

    return html;
}

/**
 * Generate WordPress markup for a single meeting
 * @param {Object} meeting - Meeting data object
 * @param {boolean} isEveningAgenda - Whether this is an evening agenda
 * @param {boolean} hasMultipleMeetings - Whether there are multiple meetings for this date
 * @returns {string} - WordPress block markup
 */
function generateSingleMeetingMarkup(meeting, isEveningAgenda = false, hasMultipleMeetings = false, secondaryLabel = 'Evening Agenda', addenda = []) {
    // Start with intro paragraph (only for first meeting)
    let wpHtml = '';

    // Build addendum lookup maps from paired addenda. Walk-ons are not
    // tracked here — they render only in the Addendum section, never as
    // injected agenda items.
    const continuedItems = new Map(); // itemNumber -> continuedToDate string
    const updatedItemNums = new Set(); // item numbers with non-continuance addendum changes

    for (const addendum of addenda) {
        for (const item of (addendum.agendaItems || [])) {
            if (item.continuedToDate) {
                continuedItems.set(item.number, item.continuedToDate);
            } else if (item.addendumSection && item.addendumSection !== 'walkons') {
                // Only flag as "Updated" when we have explicit section metadata (new scrapes)
                updatedItemNums.add(item.number);
            }
            // Items scraped before section metadata was added (no addendumSection) still
            // appear in the addendum summary section at the bottom via renderAddendumSection,
            // but do NOT trigger inline notices on main agenda items.
        }
    }
    
    // Determine the agenda type label (defaults to "draft" if not specified)
    const agendaTypeLower = meeting.agendaType === 'FINAL' ? 'final' : 'draft';
    
    if (!isEveningAgenda) {
        wpHtml = `<!-- wp:paragraph -->
<p>This is a reimagined version of the Tampa City Council agenda. It removes legalese from the description, parses the Background details from the Summary Sheet when available and provides links to supporting documents. Also included is a zoning map with current applications. Document links point to our mirrored copies for long-term stability. For original documents, refer to the official ${agendaTypeLower} agenda from the clerk in Onbase.</p>
<!-- /wp:paragraph -->

`;

        // Add navigation links if there are multiple meetings
        if (hasMultipleMeetings) {
            wpHtml += `<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center"><strong>Quick Navigation:</strong> <a href="#morning-agenda">Morning Agenda</a> | <a href="#evening-agenda">${secondaryLabel}</a></p>
<!-- /wp:paragraph -->

`;
        }

        // Add morning/first session heading with anchor
        const sessionHeading = hasMultipleMeetings ? 'Morning Agenda' : 'Agenda';
        wpHtml += `<!-- wp:heading {"level":2} -->
<h2 id="morning-agenda">${sessionHeading}</h2>
<!-- /wp:heading -->

`;
    }

    // Add meeting link
    const correctedUrl = meeting.sourceUrl
        .replace('/Documents/ViewAgenda', '/Meetings/ViewMeeting')
        .replace('meetingId=', 'id=')
        .replace('&type=agenda', '');

    // Determine the agenda type label (defaults to "Draft" if not specified)
    const agendaTypeLabel = meeting.agendaType === 'FINAL' ? 'Final' : 'Draft';

    wpHtml += `<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap"}} -->
<div class="wp-block-group"><!-- wp:coblocks/icon {"icon":"page","href":"${correctedUrl}"} /-->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><a href="${correctedUrl}">City Clerk's ${agendaTypeLabel} Agenda in Onbase</a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

`;

    // Addendum jump link — shown prominently when paired addenda exist
    if (addenda.length > 0) {
        wpHtml += `<!-- wp:group {"className":"addendum-jump-notice"} -->
<div class="wp-block-group addendum-jump-notice"><!-- wp:paragraph --><p>📋 <strong>Addendum available.</strong> Changes were received after this agenda was published. <a href="#addendum">Jump to addendum ↓</a></p><!-- /wp:paragraph --></div>
<!-- /wp:group -->

`;
    }

    // Load OpenGov funding manifest for this meeting (may be null).
    const fundingManifest = loadFundingManifest(meeting.meetingId, meeting.formattedDate);
    const fundingByItemId = buildFundingByItemId(fundingManifest);

    // Insert "What's Changed" box for every meeting session (morning and evening),
    // loaded from its own per-meeting change-log file.
    try {
        const changeLog = loadChangeLog(meeting.meetingId, meeting.formattedDate);
        const changesBlock = renderWhatsChangedBox(changeLog, meeting);
        if (changesBlock) wpHtml += changesBlock;
    } catch (e) {
        // Non-fatal — change-log read failure should never break the render
    }

    // Insert agenda-level funding overview after the meeting link group (only
    // for the leading meeting; evening agendas share the same manifest already
    // surfaced above).
    if (!isEveningAgenda) {
        const overview = renderAgendaFundingOverview(fundingManifest);
        if (overview) wpHtml += overview + '\n';
    }

    // Process agenda items
    const processedItems = [];
    const fileNumberMatches = [];
    const foliosByFileNumber = {}; // Map file numbers to {coordinates, folios}
    let firstStrongIndex = -1;

    meeting.agendaItems.forEach((item, index) => {
        // Clean the raw title text (removing boilerplate legal language) 
        let cleanedText = cleanAgendaContent(item.rawTitle || '');
        
        const itemNumber = item.number || (index + 1);
        
        // Check if this item will have a strong tag after conversion (land use items only)
        const hasStrongTag = /\*\*File No\. (DE[12]|TA\/CPA|REZ|VAC|AB[12]|SU\d?)/i.test(cleanedText);
        
        // Extract file number for map if it has strong tag
        if (hasStrongTag) {
            const fileNoMatch = cleanedText.match(/\*\*File No\. ([A-Z\/\d-]+)\*\*/);
            if (fileNoMatch) {
                const fileNo = fileNoMatch[1];
                const [prefix, num] = fileNo.split(/-(?=[^-]+$)/);
                // Only pad if num exists and is numeric
                if (num && /^\d+$/.test(num)) {
                    const paddedNum = num.padStart(7, '0');
                    const paddedFileNo = `${prefix}-${paddedNum}`;
                    fileNumberMatches.push(`${paddedFileNo}:${itemNumber}`);
                    
                    // Store folios and coordinates if available (TA/CPA items have folios, SU1 items have coordinates only)
                    if ((item.folioNumbers && item.folioNumbers.length > 0) || item.coordinates) {
                        foliosByFileNumber[paddedFileNo] = {
                            coordinates: item.coordinates || null,
                            folios: item.folioNumbers || []
                        };
                    }
                } else {
                    // Use original file number if can't parse numeric suffix
                    fileNumberMatches.push(`${fileNo}:${itemNumber}`);
                    
                    // Store folios and coordinates if available (TA/CPA items have folios, SU1 items have coordinates only)
                    if ((item.folioNumbers && item.folioNumbers.length > 0) || item.coordinates) {
                        foliosByFileNumber[fileNo] = {
                            coordinates: item.coordinates || null,
                            folios: item.folioNumbers || []
                        };
                    }
                }
            }
        }

        // Mark file numbers for separation and remove bold formatting
        cleanedText = cleanedText.replace(/\*\*File No\. ([A-Z\/\d-]+)\*\*/gi, '|||FILE_NO_SEPARATOR|||File No. $1|||FILE_NO_SEPARATOR|||');
        
        // Remove any remaining markdown bold formatting
        cleanedText = cleanedText.replace(/\*\*([^*]+)\*\*/g, '$1');

        // Build the unified "Item details" drawer: financial impact (if any),
        // then background narrative or staff report fallback.
        const fundingItem = fundingByItemId[String(item.agendaItemId)] || null;
        const drawer = buildItemDetailsDrawer(item, fundingItem);
        if (drawer) cleanedText += drawer;

        // Add supporting documents if available
        if (item.supportingDocuments && item.supportingDocuments.length > 0) {
            cleanedText += `

<!-- wp:group {"className":"agenda-supporting-docs"} -->
<div class="wp-block-group agenda-supporting-docs">
<!-- wp:heading {"level":4} -->
<h4 class="wp-block-heading">Supporting Documents:</h4>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list">`;
            
            item.supportingDocuments.forEach(doc => {
                // Prefer mirroredUrl (from S3/R2) over original OnBase URL
                let docUrl;
                if (doc.mirroredUrl) {
                    docUrl = doc.mirroredUrl;
                } else {
                    docUrl = doc.url.startsWith('http') ? doc.url : 'https://tampagov.hylandcloud.com' + doc.url.replace(/&amp;/g, '&');
                }
                const titleCaseText = doc.title || doc.originalText || 'Document';
                cleanedText += `
<!-- wp:list-item -->
<li><a href="${docUrl}" target="_blank" rel="noopener noreferrer">${titleCaseText}</a></li>
<!-- /wp:list-item -->`;
            });
            
            cleanedText += `
</ul>
<!-- /wp:list -->
</div>
<!-- /wp:group -->`;
        }

        // Addendum inline notice — continuance or other update
        if (continuedItems.has(item.number)) {
            const continuedTo = continuedItems.get(item.number);
            cleanedText += `

<!-- wp:group {"className":"addendum-notice addendum-notice--continuance"} -->
<div class="wp-block-group addendum-notice addendum-notice--continuance"><p>⚠️ <strong>Continued to ${continuedTo}</strong> — see <a href="#addendum">Addendum</a></p></div>
<!-- /wp:group -->`;
        } else if (updatedItemNums.has(item.number)) {
            cleanedText += `

<!-- wp:group {"className":"addendum-notice addendum-notice--updated"} -->
<div class="wp-block-group addendum-notice addendum-notice--updated"><p>📋 <strong>Updated by Addendum</strong> — see <a href="#addendum">Addendum</a> for details</p></div>
<!-- /wp:group -->`;
        }

        processedItems.push({ itemNumber, cleanedText, hasStrongTag });
        
        // Track the first occurrence of a strong tag
        if (hasStrongTag && firstStrongIndex === -1) {
            firstStrongIndex = processedItems.length - 1;
        }
    });

    // Generate the agenda list(s) based on whether there's a split
    if (firstStrongIndex !== -1) {
        // First part of the list
        wpHtml += `<!-- wp:list {"ordered":true} -->
<ol class="wp-block-list">
`;
        for (let i = 0; i < firstStrongIndex; i++) {
            const { cleanedText } = processedItems[i];
            const anchorId = `item-${meeting.agendaItems[i].agendaItemId || `${meeting.meetingId}-${i + 1}`}`;
            
            // Format content with proper paragraph structure for file numbers
            let formattedContent = cleanedText;
            if (formattedContent.includes('|||FILE_NO_SEPARATOR|||')) {
                const parts = formattedContent.split('|||FILE_NO_SEPARATOR|||');
                if (parts.length === 3) {
                    // Before file no, file no, after file no
                    const beforeText = parts[0].trim();
                    const fileNoText = parts[1].trim();
                    const afterText = parts[2].trim();
                    
                    formattedContent = '';
                    if (beforeText) {
                        formattedContent += `<p>${beforeText}</p>`;
                    }
                    formattedContent += `<p class="file-number"><a href="#${anchorId}" class="item-permalink">${fileNoText}</a></p>`;
                    if (afterText) {
                        formattedContent += formatTextWithBlocks(afterText);
                    }
                } else {
                    // Fallback: just wrap in paragraph
                    formattedContent = formatTextWithBlocks(formattedContent.replace(/\|\|\|FILE_NO_SEPARATOR\|\|\|/g, ''));
                }
            } else {
                // No file number, just wrap in paragraph
                formattedContent = formatTextWithBlocks(formattedContent);
            }
            
            wpHtml += `<!-- wp:list-item -->
<li id="${anchorId}">${formattedContent}</li>
<!-- /wp:list-item -->
`;
        }
        wpHtml += `</ol>
<!-- /wp:list -->

`;
        
        // Add heading for Public Hearings & Ordinances
        wpHtml += `<!-- wp:heading {"level":3} -->
<h3>Public Hearings & Ordinances</h3>
<!-- /wp:heading -->

`;
        
        // Add the map block using extracted file numbers
        if (fileNumberMatches.length > 0) {
            const recordsStr = fileNumberMatches.join(', ');
            
            // Build folios string: "TA/CPA25-0000009:27.9506,-82.4572:189020.0000,189021.0000|SU1-25-0000077:27.9575,-82.42885"
            const foliosEntries = [];
            for (const [fileNo, data] of Object.entries(foliosByFileNumber)) {
                if (data.coordinates && data.folios.length > 0) {
                    // Format with folios: FILE:lat,lng:folio1,folio2,folio3
                    const coordStr = `${data.coordinates.lat},${data.coordinates.lng}`;
                    foliosEntries.push(`${fileNo}:${coordStr}:${data.folios.join(',')}`);
                } else if (data.coordinates) {
                    // Format without folios (SU1 items): FILE:lat,lng
                    const coordStr = `${data.coordinates.lat},${data.coordinates.lng}`;
                    foliosEntries.push(`${fileNo}:${coordStr}`);
                } else if (data.folios.length > 0) {
                    // Fallback: if no coordinates, just use FILE:folio1,folio2
                    foliosEntries.push(`${fileNo}:${data.folios.join(',')}`);
                }
            }
            const foliosStr = foliosEntries.length > 0 ? foliosEntries.join('|') : '';
            
            // Add folios attribute only if we have folio data
            const foliosAttr = foliosStr ? `,"folios":"${foliosStr}"` : '';
            const foliosDataAttr = foliosStr ? ` data-folios="${foliosStr}"` : '';
            
            wpHtml += `<!-- wp:map-current-dev/block {"records":"${recordsStr}"${foliosAttr}} -->
<div class="wp-block-map-current-dev-block mapbox-block" data-center="[-82.4572,27.9506]" data-zoom="11" data-records="${recordsStr}"${foliosDataAttr} data-show-geocoder="true" data-geocoder-position="top-right" data-show-legend="true" data-legend-position="bottom-left"></div>
<!-- /wp:map-current-dev/block -->

`;
        }
        
        // Second part of the list
        const startNumber = processedItems[firstStrongIndex].itemNumber;
        wpHtml += `<!-- wp:list {"ordered":true,"start":${startNumber}} -->
<ol start="${startNumber}" class="wp-block-list">
`;
        for (let i = firstStrongIndex; i < processedItems.length; i++) {
            const { cleanedText } = processedItems[i];
            const anchorId = `item-${meeting.agendaItems[i].agendaItemId || `${meeting.meetingId}-${i + 1}`}`;
            
            // Format content with proper paragraph structure for file numbers
            let formattedContent = cleanedText;
            if (formattedContent.includes('|||FILE_NO_SEPARATOR|||')) {
                const parts = formattedContent.split('|||FILE_NO_SEPARATOR|||');
                if (parts.length === 3) {
                    // Before file no, file no, after file no
                    const beforeText = parts[0].trim();
                    const fileNoText = parts[1].trim();
                    const afterText = parts[2].trim();
                    
                    formattedContent = '';
                    if (beforeText) {
                        formattedContent += `<p>${beforeText}</p>`;
                    }
                    formattedContent += `<p class="file-number"><a href="#${anchorId}" class="item-permalink">${fileNoText}</a></p>`;
                    if (afterText) {
                        formattedContent += formatTextWithBlocks(afterText);
                    }
                } else {
                    // Fallback: just wrap in paragraph
                    formattedContent = formatTextWithBlocks(formattedContent.replace(/\|\|\|FILE_NO_SEPARATOR\|\|\|/g, ''));
                }
            } else {
                // No file number, just wrap in paragraph
                formattedContent = formatTextWithBlocks(formattedContent);
            }
            
            wpHtml += `<!-- wp:list-item -->
<li id="${anchorId}">${formattedContent}</li>
<!-- /wp:list-item -->
`;
        }
        wpHtml += `</ol>
<!-- /wp:list -->
`;
    } else {
        // Single list
        wpHtml += `<!-- wp:list {"ordered":true} -->
<ol class="wp-block-list">
`;
        processedItems.forEach(({ cleanedText }, index) => {
            const anchorId = `item-${meeting.agendaItems[index].agendaItemId || `${meeting.meetingId}-${index + 1}`}`;
            
            // Format content with proper paragraph structure for file numbers
            let formattedContent = cleanedText;
            if (formattedContent.includes('|||FILE_NO_SEPARATOR|||')) {
                const parts = formattedContent.split('|||FILE_NO_SEPARATOR|||');
                if (parts.length === 3) {
                    // Before file no, file no, after file no
                    const beforeText = parts[0].trim();
                    const fileNoText = parts[1].trim();
                    const afterText = parts[2].trim();
                    
                    formattedContent = '';
                    if (beforeText) {
                        formattedContent += `<p>${beforeText}</p>`;
                    }
                    formattedContent += `<p class="file-number"><a href="#${anchorId}" class="item-permalink">${fileNoText}</a></p>`;
                    if (afterText) {
                        formattedContent += formatTextWithBlocks(afterText);
                    }
                } else {
                    // Fallback: just wrap in paragraph
                    formattedContent = formatTextWithBlocks(formattedContent.replace(/\|\|\|FILE_NO_SEPARATOR\|\|\|/g, ''));
                }
            } else {
                // No file number, just wrap in paragraph
                formattedContent = formatTextWithBlocks(formattedContent);
            }
            
            wpHtml += `<!-- wp:list-item -->
<li id="${anchorId}">${formattedContent}</li>
<!-- /wp:list-item -->
`;
        });
        wpHtml += `</ol>
<!-- /wp:list -->
`;
    }

    // Append addendum summary section if addenda were provided
    if (addenda.length > 0) {
        const addendumSection = renderAddendumSection(addenda);
        if (addendumSection) wpHtml += '\n' + addendumSection;
    }

    return wpHtml;
}

/**
 * Get output filename for the generated markup
 * @param {Array} meetings - Array of meeting data objects
 * @returns {string} - Output filename
 */
function getOutputFilename(meetings) {
    if (meetings.length === 1) {
        const meeting = meetings[0];
        if (meeting.formattedDate) {
            return `agenda_${meeting.formattedDate}.wp.html`;
        } else {
            return `agenda_${meeting.meetingId}.wp.html`;
        }
    } else if (meetings.length > 1) {
        // Multiple meetings - use date if all have same date, otherwise use meeting IDs
        const dates = [...new Set(meetings.map(m => m.formattedDate).filter(d => d))];
        if (dates.length === 1) {
            return `agenda_${dates[0]}.wp.html`;
        } else {
            const ids = meetings.map(m => m.meetingId).join('_');
            return `agenda_${ids}.wp.html`;
        }
    }
    
    return 'agenda_output.wp.html';
}

/**
 * Main function to process meetings and generate WordPress markup
 * @param {Array} meetingIds - Array of meeting IDs to process
 * @param {string} date - Date to process (optional)
 */
async function main(meetingIds = [], date = null) {
    const meetings = [];
    const dataDir = path.join(__dirname, 'data');
    
    // If date is provided, find all JSON files for that date
    if (date) {
        const jsonFiles = findJSONFilesForDate(date);
        console.log(`Found ${jsonFiles.length} JSON files for date ${date}`);
        
        for (const filePath of jsonFiles) {
            const meetingData = loadJSONData(filePath);
            if (meetingData) {
                meetings.push(meetingData);
                console.log(`Loaded meeting ${meetingData.meetingId} (${meetingData.meetingType})`);
            }
        }
    }
    
    // If meeting IDs are provided, load those specific meetings
    if (meetingIds.length > 0) {
        for (const meetingId of meetingIds) {
            // Look for JSON file with this meeting ID
            const jsonFiles = fs.readdirSync(dataDir).filter(file => 
                file.startsWith(`meeting_${meetingId}_`) && file.endsWith('.json')
            );
            
            if (jsonFiles.length > 0) {
                const filePath = path.join(dataDir, jsonFiles[0]);
                const meetingData = loadJSONData(filePath);
                if (meetingData) {
                    meetings.push(meetingData);
                    console.log(`Loaded meeting ${meetingData.meetingId} (${meetingData.meetingType})`);
                }
            } else {
                console.warn(`No JSON file found for meeting ID ${meetingId}`);
            }
        }

        // Auto-load addendum meetings for the same date(s) so they are merged into output
        const loadedDates = new Set(meetings.map(m => m.formattedDate).filter(Boolean));
        const loadedIds = new Set(meetings.map(m => m.meetingId));
        for (const meetingDate of loadedDates) {
            const addendumFiles = findJSONFilesForDate(meetingDate);
            for (const filePath of addendumFiles) {
                const meetingData = loadJSONData(filePath);
                if (meetingData && meetingData.isAddendum && !loadedIds.has(meetingData.meetingId)) {
                    meetings.push(meetingData);
                    loadedIds.add(meetingData.meetingId);
                    console.log(`Auto-loaded addendum meeting ${meetingData.meetingId} for ${meetingDate}`);
                }
            }
        }
    }
    
    if (meetings.length === 0) {
        console.error('No meetings found to process');
        return;
    }
    
    // Sort meetings: morning types first (cra, workshop, special), evening last
    meetings.sort((a, b) => {
        const getTypePriority = (meetingType) => {
            const type = (meetingType || '').toLowerCase();
            if (type === 'evening' || type === 'council evening') {
                return 999;
            }
            return 1;
        };
        
        const aType = getTypePriority(a.meetingType);
        const bType = getTypePriority(b.meetingType);
        
        if (aType !== bType) {
            return aType - bType;
        }
        
        return parseInt(a.meetingId) - parseInt(b.meetingId);
    });
    
    // Generate WordPress markup (handles file writing internally)
    generateWordPressMarkup(meetings);
    
    console.log(`\nWordPress markup generated successfully!`);
    
    // Get output filename for reporting
    const outputFilename = getOutputFilename(meetings);
    const outputPath = path.join(__dirname, 'agendas', outputFilename);
    console.log(`Output file: ${outputPath}`);
    console.log(`Processed ${meetings.length} meeting(s) with ${meetings.reduce((total, m) => total + (m.agendaItems?.length || 0), 0)} agenda items`);
}

// Run the script
if (require.main === module) {
    const options = parseArguments();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    if (options.meetingIds.length === 0 && !options.date) {
        console.error('Error: Please specify either meeting IDs or a date to process.');
        console.error('Use --help for usage information.');
        process.exit(1);
    }
    
    main(options.meetingIds, options.date).catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
}

module.exports = {
    generateWordPressMarkup,
    loadJSONData,
    findJSONFilesForDate
};

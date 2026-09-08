const fs = require('fs');
const path = require('path');
const { integrateStaffReportsIntoAgendaItems } = require('./staff-report-parser');
const { loadChangeLog, saveChangeLog, appendOrMergeEntry } = require('./lib/change-log');
const { computeMeetingDiff, diffIsEmpty } = require('./lib/diff-meeting');
const { mergeWithExisting } = require('./lib/scrape-guard');

// HTTP scraper module (default)
const { createSession, fetchMeeting, fetchMeetingList } = require('./lib/http-meeting-scraper');

/**
 * Format a date string for use in filenames (converts to YYYY-MM-DD format)
 * @param {string} dateStr - Date string in various formats
 * @returns {string} - Formatted date string or empty string if invalid
 */
function formatDateForFilename(dateStr) {
    if (!dateStr) return '';
    
    try {
        // Handle common date formats
        let date;
        
        // Try parsing MM/DD/YYYY format
        const mmddyyyy = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (mmddyyyy) {
            const [, month, day, year] = mmddyyyy;
            date = new Date(year, month - 1, day);
        }
        // Try parsing YYYY-MM-DD format
        else if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            date = new Date(dateStr);
        }
        // Try parsing "Month DD, YYYY" format
        else {
            date = new Date(dateStr);
        }
        
        // Validate the date
        if (isNaN(date.getTime())) {
            return '';
        }
        
        // Format as YYYY-MM-DD
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    } catch (error) {
        return '';
    }
}

/**
 * Format background text to properly structure numbered lists and improve readability
 * @param {string} text - Raw background text from PDF
 * @returns {string} - Formatted background text
 */
function formatBackgroundText(text) {
    if (!text || text.trim().length === 0) return text;
    
    // Structure-based PDF formatting - trust the PDF parser's output
    // Only clean up obvious PDF artifacts that don't affect structure
    let cleanText = text
        // Fix split dollar amounts like "$452,\n962.55" -> "$452,962.55"  
        .replace(/\$(\d{1,3}(?:,\d{3})*),\s*\n\s*(\d{3}(?:\.\d{2})?)/g, '$$$1,$2')
        // Fix split document references like "R\n1182" -> "R1182"
        .replace(/\b(Resolution|Contract|Case|File|R)\s*\n\s*(\d+)/gi, '$1$2')
        // Fix split contract numbers, case numbers, etc.
        .replace(/(\b(?:Contract|Resolution|Case|File|No\.?|Number))\s*\n\s*([A-Z0-9-]+)/gi, '$1 $2')
        // Fix split dates like "01/05/\n2024" -> "01/05/2024"
        .replace(/(\d{1,2}\/\d{1,2}\/)\s*\n\s*(\d{4})/g, '$1$2')
        // Fix hyphen-wrapped words/identifiers: "Design-\nBuild" -> "Design-Build",
        // "2022-\n230" -> "2022-230", "agree-\nment" -> "agreement".
        // Only join when the char before '-' and the char after the newline are
        // both word characters (letter/digit), to avoid touching em-dashes or
        // bullet-style "- item" lines.
        .replace(/(\w)-\n\s*(\w)/g, '$1-$2')
        .trim();
    
    // Use the PDF's natural structure: split on lines and analyze the structure
    const lines = cleanText.split('\n');
    const processedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Check if this line starts a numbered item
        if (/^\d+\.\s+/.test(line)) {
            // This is a numbered item - add with separation
            if (processedLines.length > 0) {
                processedLines.push(''); // Add separation before new numbered item
            }
            processedLines.push(line);
        } else {
            // This is a continuation line
            // Check if the previous line ended with a sentence-ending punctuation
            const lastLine = processedLines[processedLines.length - 1];
            
            if (lastLine && (lastLine.endsWith('.') || lastLine.endsWith('!') || lastLine.endsWith('?'))) {
                // Previous line ended with sentence-ending punctuation
                // This suggests a natural paragraph break in the PDF
                processedLines.push(''); // Add separation
                processedLines.push(line);
            } else {
                // This is a continuation of the previous line
                if (processedLines.length > 0) {
                    processedLines[processedLines.length - 1] += ' ' + line;
                } else {
                    processedLines.push(line);
                }
            }
        }
    }
    
    // Join with double newlines and clean up
    const result = processedLines
        .filter(line => line !== undefined && line !== null)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
        
    return result;
}

/**
 * Extract file number from agenda item text
 * @param {string} text - Agenda item text
 * @returns {string|null} - Extracted file number or null if not found
 */
function extractFileNumber(text) {
    if (!text) return null;

    const normalizeFileNumber = (value) =>
        value
            .replace(/\s*-\s*/g, '-')
            .replace(/\s*\/\s*/g, '/')
            .replace(/\s+/g, ' ')
            .trim();

    const patterns = [
        // Standard "File No." prefix with flexible separators/spaces
        /File\s+No\.?\s+([A-Z]{1,5}(?:\s*\d{1,4})?(?:\s*[-\/]\s*[A-Z\d]{1,8})*)/i,
        // TA/CPA special case that sometimes lacks the "File No." prefix
        /\b(TA\/CPA\d{1,4}\s*[-\/]\s*\d{1,6})\b/i,
        // REZ/CPA/PD cases with optional separators
        /\b((?:REZ|CPA|PD)\s*[-\/]?\d{2,4}\s*[-\/]\s*\d{1,6}(?:\s*[-\/]\s*[A-Z\d]+)*)\b/i,
        // General direct file number pattern (captures CM25-12001, FDN 25-36-C, etc.)
        /\b([A-Z]{1,5}(?:\s*\d{1,4})?(?:\s*[-\/]\s*[A-Z\d]{1,8})+)\b/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            return normalizeFileNumber(match[1]);
        }
    }
    
    // Pattern 2: Direct file number pattern (for items without "File No." prefix)
    // Matches patterns like CM25-13759, E2025-15, PS25-15649, FDN 25-36-C, etc.
    const directFileMatch = text.match(/^([A-Z]{1,5}\d{2,4}-\d{2,6}(?:-[A-Z])?)/i);
    if (directFileMatch) {
        return directFileMatch[1];
    }

    if (/Administration Update/i.test(text)) {
        return 'Administration Update';
    }

    return null;
}

/**
 * Runs right before the meeting JSON is written.
 * Reconciles the fresh scrape with the stored file (lib/scrape-guard.js):
 * refuses an empty or wholly failed scrape, keeps the stored version of any
 * item whose fetch failed or lost all its documents, carries mirroredUrl
 * stamps forward (OnBase publishId URLs change but R2 is permanent), and
 * records the meaningful diff in the public change-log.
 * @throws {Error} when the fresh scrape must not be written
 */
function preserveMirrorsAndLogChanges(outputFileName, meetingData) {
    if (fs.existsSync(outputFileName)) {
        let existing = null;
        try {
            existing = JSON.parse(fs.readFileSync(outputFileName, 'utf8'));
        } catch (e) {
            console.warn(`Warning: existing ${path.basename(outputFileName)} unreadable (${e.message}) — writing fresh scrape`);
        }
        if (existing) {
            const merged = mergeWithExisting(existing, meetingData);
            if (merged.refused) {
                throw new Error(`Refusing to overwrite ${path.basename(outputFileName)}: ${merged.refused}`);
            }
            for (const kept of merged.keptItems) {
                console.warn(`Kept stored version of item ${kept.number} (${kept.reason})`);
            }
            if (merged.restoredMirrors > 0) {
                console.log(`Preserved ${merged.restoredMirrors} mirrored document URLs from previous scrape`);
            }

            // Capture meaningful diff for the public change-log
            try {
                const diff = computeMeetingDiff(existing, meetingData);
                if (!diffIsEmpty(diff)) {
                    const changeLog = loadChangeLog(meetingData.meetingId, meetingData.formattedDate);
                    appendOrMergeEntry(changeLog, {
                        scrapedAt: new Date().toISOString(),
                        agendaTypePromoted: diff.agendaTypePromoted,
                        itemsAdded: diff.itemsAdded,
                        itemsRemoved: diff.itemsRemoved,
                        newDocuments: diff.documentsAdded,
                    });
                    saveChangeLog(changeLog);
                }
            } catch (changeLogErr) {
                console.warn(`Warning: change-log update failed: ${changeLogErr.message}`);
            }
        }
    } else {
        // First scrape — initialise the log with firstSeenAt so we have a baseline
        try {
            const changeLog = loadChangeLog(meetingData.meetingId, meetingData.formattedDate);
            if (!changeLog.firstSeenAt) {
                changeLog.firstSeenAt = new Date().toISOString();
                saveChangeLog(changeLog);
            }
        } catch (changeLogErr) {
            console.warn(`Warning: change-log initialisation failed: ${changeLogErr.message}`);
        }
    }
}

/**
 * Scrape meeting using HTTP (default method)
 * @param {string} meetingId - Meeting ID
 * @param {string} meetingType - Meeting type
 * @param {Object} session - Axios session (optional)
 * @param {string} targetDate - YYYY-MM-DD; skip the meeting if it's on another date
 * @param {string} meetingName - Clerk's meeting name from the list page (optional)
 * @returns {Promise<void>}
 */
/** The meeting JSON already on disk for an OnBase id, or null. */
function findStoredMeeting(meetingId) {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) return null;
    const file = fs.readdirSync(dataDir).find(f => f.startsWith(`meeting_${meetingId}_`) && f.endsWith('.json') && !f.includes('_old'));
    if (!file) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    } catch {
        return null;
    }
}

async function scrapeWithHTTP(meetingId, meetingType = 'regular', session = null, targetDate = null, meetingName = null) {
    console.log(`\n[HTTP] Starting scrape for meeting ${meetingId} (${meetingType})`);

    try {
        // Fetch meeting data using HTTP module
        const meetingData = await fetchMeeting(meetingId, meetingType, {
            session,
            saveDebugFiles: true,
            extractFileNumber,
            formatBackgroundText,
            targetDate,
            meetingName,
            normalizeDate: formatDateForFilename
        });

        // Meeting not available on server — skip without error
        if (meetingData === null) {
            console.log(`[HTTP] Meeting ${meetingId} skipped (not available on server).`);
            return;
        }

        // Meeting is on a different date than requested — nothing written,
        // so its existing JSON (and mirroredUrl stamps) stay untouched
        if (meetingData.skipped) {
            return;
        }

        // Integrate staff reports if available
        if (meetingData.agendaItems && meetingData.agendaItems.length > 0) {
            // Pass the entire meetingData object, not just agendaItems
            await integrateStaffReportsIntoAgendaItems(meetingData);
        }

        // formattedDate is what json-to-markdown.js and mirror-documents.js key on
        meetingData.formattedDate = formatDateForFilename(meetingData.meetingDate);
        const dateString = meetingData.formattedDate || 'unknown-date';

        // Save to JSON file
        const filename = path.join(__dirname, 'data', `meeting_${meetingId}_${dateString}.json`);
        
        // Ensure data directory exists
        if (!fs.existsSync(path.join(__dirname, 'data'))) {
            fs.mkdirSync(path.join(__dirname, 'data'));
        }

        preserveMirrorsAndLogChanges(filename, meetingData);

        fs.writeFileSync(filename, JSON.stringify(meetingData, null, 2));
        console.log(`[HTTP] ✅ Meeting ${meetingId} saved to: ${filename}`);
        
        // Print summary
        console.log(`[HTTP] Summary: ${meetingData.agendaItems.length} items, date: ${meetingData.meetingDate}`);
    } catch (error) {
        console.error(`[HTTP] ❌ Failed to scrape meeting ${meetingId}:`, error.message);
        throw error;
    }
}

/**
 * Main function
 */
async function main() {
    // Check if a specific meeting ID was provided as command line argument
    const args = process.argv.slice(2);

    // Check for --date <YYYY-MM-DD> flag
    const dateArgIndex = args.indexOf('--date');
    const targetDate = dateArgIndex !== -1 ? args[dateArgIndex + 1] : null;

    // Check for --type <regular|evening|cra|workshop|special> flag — needed for
    // historical meetings, whose type can't be looked up from the current list
    const typeArgIndex = args.indexOf('--type');
    const typeOverride = typeArgIndex !== -1 ? args[typeArgIndex + 1] : null;

    const filteredArgs = args.filter((arg, i) => {
        if (arg === '--date' || arg === '--type') return false;
        if (i > 0 && (args[i - 1] === '--date' || args[i - 1] === '--type')) return false;
        return true;
    });
    const specificMeetingId = filteredArgs[0];

    console.log(`\n🚀 Tampa Agenda Scraper`);
    console.log(`Engine: HTTP\n`);

    const session = await createSession();

    if (specificMeetingId) {
        // For specific meeting ID, fetch its type from the meeting list
        // (or take --type, since historical meetings aren't on the list)
        let meetingType;
        let meetingName = null;
        if (typeOverride) {
            meetingType = typeOverride;
            console.log(`[HTTP] Using type override for ID ${specificMeetingId}: ${meetingType}`);
        } else {
            console.log(`[HTTP] Fetching meeting type for ID ${specificMeetingId}...`);
            const meetings = await fetchMeetingList({ session });
            const meetingInfo = meetings.find(m => m.id === specificMeetingId);
            const stored = findStoredMeeting(specificMeetingId);
            if (meetingInfo) {
                meetingType = meetingInfo.type;
                meetingName = meetingInfo.name;
            } else if (stored) {
                // Historical meetings are off the current list; a re-scrape
                // used to demote them to 'regular' and change the post slug.
                meetingType = stored.meetingType || 'regular';
                meetingName = stored.meetingName || null;
                console.log(`[HTTP] ID ${specificMeetingId} not on the current list — keeping stored type '${meetingType}'`);
            } else {
                meetingType = 'regular';
            }
        }

        // Process single meeting
        await scrapeWithHTTP(specificMeetingId, meetingType, session, null, meetingName);
        return;
    }

    // Get meetings with their IDs and types
    let meetings = await fetchMeetingList({ session });
    console.log(`[HTTP] Found ${meetings.length} meetings to process\n`);

    // Filter by target date when --date is specified
    if (targetDate) {
        const withDates = meetings.filter(m => m.date !== null);
        if (withDates.length > 0) {
            const filtered = meetings.filter(m => m.date === targetDate);
            console.log(`[HTTP] Filtering to date ${targetDate}: ${filtered.length} of ${meetings.length} meeting(s) match\n`);
            meetings = filtered;
        } else {
            console.log(`[HTTP] No date info in meeting list — scraping all and filtering by date ${targetDate} after fetch\n`);
        }
    }

    // Scrape each meeting sequentially
    const failed = [];
    for (let i = 0; i < meetings.length; i++) {
        const meeting = meetings[i];
        console.log(`[HTTP] Processing meeting ${i + 1}/${meetings.length}: ${meeting.id} (${meeting.type})`);
        try {
            await scrapeWithHTTP(meeting.id, meeting.type, session, targetDate, meeting.name);
        } catch (err) {
            console.error(`[HTTP] ⚠️  Skipping meeting ${meeting.id} after error: ${err.message}`);
            failed.push(meeting.id);
        }
    }

    if (failed.length > 0) {
        console.warn(`\n[HTTP] ⚠️  ${failed.length} meeting(s) failed: ${failed.join(', ')}`);
        process.exitCode = 1;
    }
    console.log(`\n[HTTP] ✅ Finished processing ${meetings.length - failed.length}/${meetings.length} meetings`);
}

// Call the main function
if (require.main === module) {
    main();
}

// Export functions for testing
module.exports = {
    scrapeWithHTTP,
    extractFileNumber,
    formatBackgroundText
};

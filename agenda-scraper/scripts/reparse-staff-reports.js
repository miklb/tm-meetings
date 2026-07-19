#!/usr/bin/env node
/**
 * Re-run staff report parsing for an already-scraped meeting.
 *
 * Safe partial re-run (unlike running json-scraper.js standalone): reads
 * data/meeting_<id>_<date>.json, re-downloads each land-use item's staff
 * report PDF (preferring the R2 mirror), re-parses zoning/waivers/findings,
 * and writes the JSON back. Only the per-item `staffReport` fields change —
 * mirroredUrl stamps and all other scraped data are preserved.
 *
 * Use after improving staff-report-parser.js to refresh an existing meeting,
 * then regenerate the post with: node json-to-markdown.js --date <YYYY-MM-DD>
 *
 * Usage: node scripts/reparse-staff-reports.js <meetingId>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { integrateStaffReportsIntoAgendaItems } = require('../staff-report-parser');

async function main() {
    const meetingId = process.argv[2];
    if (!meetingId || !/^\d+$/.test(meetingId)) {
        console.error('Usage: node scripts/reparse-staff-reports.js <meetingId>');
        process.exit(1);
    }

    const dataDir = path.join(__dirname, '..', 'data');
    const match = fs.readdirSync(dataDir)
        .filter(f => new RegExp(`^meeting_${meetingId}_\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f));

    if (match.length !== 1) {
        console.error(`Expected exactly one data file for meeting ${meetingId}, found: ${match.join(', ') || 'none'}`);
        process.exit(1);
    }

    const filePath = path.join(dataDir, match[0]);
    const meetingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    await integrateStaffReportsIntoAgendaItems(meetingData);

    fs.writeFileSync(filePath, JSON.stringify(meetingData, null, 2));
    console.log(`\n💾 Updated ${match[0]}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

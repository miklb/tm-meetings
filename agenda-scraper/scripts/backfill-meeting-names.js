#!/usr/bin/env node
/**
 * Backfill `meetingName` (the clerk's own meeting name, e.g. "CRA Special
 * Call") into already-scraped meeting JSON files.
 *
 * Safe partial re-run (unlike running json-scraper.js standalone): reads the
 * saved output/http_meeting_<id>.html page for each data/meeting_*.json that
 * lacks meetingName, extracts the name from its <title>, and writes the JSON
 * back with only that one field added — mirroredUrl stamps and all other
 * scraped data are preserved. Files whose saved page carries no name (older
 * "View Meeting" pages) are left untouched.
 *
 * Usage: node scripts/backfill-meeting-names.js [--dry-run]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { extractMeetingName } = require('../lib/http-utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const dryRun = process.argv.includes('--dry-run');

function main() {
    const files = fs.readdirSync(DATA_DIR)
        .filter(f => /^meeting_\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();

    let updated = 0, already = 0, noPage = 0, noName = 0;
    for (const file of files) {
        const jsonPath = path.join(DATA_DIR, file);
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (data.meetingName) { already++; continue; }

        const pagePath = path.join(OUTPUT_DIR, `http_meeting_${data.meetingId}.html`);
        if (!fs.existsSync(pagePath)) {
            console.log(`⏭  ${file}: no saved page (output/http_meeting_${data.meetingId}.html)`);
            noPage++;
            continue;
        }
        const name = extractMeetingName(fs.readFileSync(pagePath, 'utf8'));
        if (!name) {
            console.log(`⏭  ${file}: saved page has no clerk name in <title>`);
            noName++;
            continue;
        }

        // Insert meetingName right after meetingType so the diff reads cleanly.
        const out = {};
        for (const [k, v] of Object.entries(data)) {
            out[k] = v;
            if (k === 'meetingType') out.meetingName = name;
        }
        if (!('meetingName' in out)) out.meetingName = name;

        console.log(`${dryRun ? '🔍' : '✅'} ${file}: "${name}" (${data.meetingType})`);
        if (!dryRun) fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
        updated++;
    }

    console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${updated}; already had name ${already}; ` +
        `no saved page ${noPage}; page without name ${noName}; total ${files.length}`);
}

main();

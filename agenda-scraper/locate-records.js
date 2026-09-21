#!/usr/bin/env node
/**
 * Resolve map locations for a meeting's land use items and store them.
 *
 * Runs in process-agenda.sh between the OpenGov reconcile and the Markdown
 * step. Looks each unlocated record up in the dev-coord feed (current view,
 * then archived) and adds what it finds to the meeting's locations sidecar
 * (see lib/record-locations.js). json-to-markdown.js then emits those points
 * as explicit coordinates, so the pins no longer depend on the live feed.
 *
 * Never fatal: if the feed is unreachable the post is still generated, and any
 * record without a stored location falls back to the live lookup as before.
 *
 * Usage:
 *   node locate-records.js --date YYYY-MM-DD
 *   node locate-records.js <meetingId> [<meetingId> ...]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { fetchRecords } = require('./lib/dev-coord');
const {
    loadRecordLocations, recordsToLocate, mergeLocations, saveRecordLocations,
} = require('./lib/record-locations');

const DATA_DIR = path.join(__dirname, 'data');

function meetingFiles(args) {
    const dateIdx = args.indexOf('--date');
    const date = dateIdx !== -1 ? args[dateIdx + 1] : args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const ids = args.filter((a) => /^\d+$/.test(a));
    return fs.readdirSync(DATA_DIR)
        .filter((f) => /^meeting_\d+_\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .filter((f) => (date && f.endsWith(`_${date}.json`)) || ids.some((id) => f.startsWith(`meeting_${id}_`)))
        .map((f) => path.join(DATA_DIR, f));
}

async function main() {
    const files = meetingFiles(process.argv.slice(2));
    if (!files.length) {
        console.log('[locate] no meeting files matched; nothing to do');
        return;
    }
    const today = new Date().toISOString().slice(0, 10);

    for (const file of files) {
        const meeting = JSON.parse(fs.readFileSync(file, 'utf8'));
        const date = meeting.formattedDate;
        const stored = loadRecordLocations(meeting.meetingId, date);
        const wanted = recordsToLocate(meeting.agendaItems, stored);
        if (!wanted.length) {
            console.log(`[locate] meeting ${meeting.meetingId}: nothing new to locate (${Object.keys(stored).length} stored)`);
            continue;
        }

        const found = await fetchRecords(wanted);
        const { records, added } = mergeLocations(stored, found, today);
        if (added.length) saveRecordLocations(meeting.meetingId, date, records);

        const missing = wanted.filter((id) => !records[id]);
        console.log(`[locate] meeting ${meeting.meetingId}: located ${added.length} of ${wanted.length}` +
            (missing.length ? `; no location stored for ${missing.join(', ')} (the map looks those up live, as before)` : ''));
    }
}

main().catch((err) => {
    // Deliberately exit 0: a map pin is never worth failing the agenda run.
    console.warn(`[locate] ⚠️  skipped: ${err.message}`);
});

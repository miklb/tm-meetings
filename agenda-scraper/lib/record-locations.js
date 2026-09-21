/**
 * Hard-coded map locations for a council meeting's land use items.
 *
 * The agenda map used to find every permit point in the live dev-coord feed
 * when a reader opened the post, so a pin disappeared once the City archived
 * the record. locate-records.js now resolves each record when the agenda is
 * processed and keeps the answer in a sidecar next to the meeting data:
 *
 *   data/locations/<meetingId>-<date>-locations.json
 *
 * A sidecar, not a field on the item, because the nightly scrape rewrites the
 * meeting files and would drop it (same reasoning as the funding manifest).
 * Entries are only ever added: once a record has been located it stays
 * located, whatever later happens to it in the feed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOCATIONS_DIR = path.join(__dirname, '..', 'data', 'locations');

// Land use file numbers that are Accela records (same set the map block uses).
const MAP_FILE_RE = /^(DE[12]|TA\/CPA|REZ|VAC|AB[12]|SU\d?)/i;

/**
 * Pad a land-use file number's numeric suffix to 7 digits so it matches
 * the Datasette feed's RECORDID.
 */
function padFileNumber(fileNo) {
    const [prefix, num] = String(fileNo || '').split(/-(?=[^-]+$)/);
    if (num && /^\d+$/.test(num)) return `${prefix}-${num.padStart(7, '0')}`;
    return fileNo;
}

const locationsFile = (meetingId, formattedDate) =>
    path.join(LOCATIONS_DIR, `${meetingId}-${formattedDate}-locations.json`);

/** @returns {Object<string, object>} recordId → location; {} when none stored */
function loadRecordLocations(meetingId, formattedDate) {
    if (!meetingId || !formattedDate) return {};
    const file = locationsFile(meetingId, formattedDate);
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).records || {};
    } catch (err) {
        console.error(`Failed to parse ${file}:`, err.message);
        return {};
    }
}

/**
 * Record ids worth looking up: mappable items the scraper did not already
 * geocode, minus what is already stored.
 */
function recordsToLocate(items, stored) {
    const ids = new Set();
    for (const item of items || []) {
        const fileNo = item.fileNumber || '';
        if (!MAP_FILE_RE.test(fileNo) || item.coordinates) continue;
        const id = padFileNumber(fileNo);
        if (!stored[id]) ids.add(id);
    }
    return [...ids];
}

/**
 * Add newly found records to what is stored. Never removes or replaces.
 * @param {Object} stored        recordId → location
 * @param {Map<string, object>} found  recordId → dev-coord record
 * @param {string} today         YYYY-MM-DD
 * @returns {{records: Object, added: string[]}}
 */
function mergeLocations(stored, found, today) {
    const records = { ...stored };
    const added = [];
    for (const [id, r] of found) {
        if (records[id]) continue;
        records[id] = {
            lat: r.lat,
            lng: r.lng,
            address: r.address,
            neighborhood: r.neighborhood,
            councilDistrict: r.councilDistrict,
            accelaUrl: r.accelaUrl,
            locatedOn: today,
        };
        added.push(id);
    }
    return { records, added };
}

function saveRecordLocations(meetingId, formattedDate, records) {
    fs.mkdirSync(LOCATIONS_DIR, { recursive: true });
    const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(
        locationsFile(meetingId, formattedDate),
        `${JSON.stringify({ meetingId, date: formattedDate, records: sorted }, null, 2)}\n`
    );
}

module.exports = {
    MAP_FILE_RE,
    padFileNumber,
    loadRecordLocations,
    recordsToLocate,
    mergeLocations,
    saveRecordLocations,
};

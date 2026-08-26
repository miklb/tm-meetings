#!/usr/bin/env node
/**
 * backfill-change-log.js — rebuild a meeting's change log from git history.
 *
 * Walks every commit that touched data/meeting_<id>_<date>.json, diffs each
 * version against the previous one (items added/removed, DRAFT→FINAL,
 * supporting documents added) and writes one change-log entry per commit
 * *author date* (America/New_York). Use when the log missed changes — e.g.
 * before 2026-08-26 the nightly scraper never logged new documents, so
 * everything the mirror step later uploaded was dated the day it was
 * mirrored rather than the day it appeared on OnBase.
 *
 * Usage:
 *   node scripts/backfill-change-log.js <meetingId> <YYYY-MM-DD> [--write]
 *
 * Without --write it prints the entries it would produce.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { computeMeetingDiff, diffIsEmpty } = require('../lib/diff-meeting');
const { loadChangeLog, saveChangeLog, appendOrMergeEntry } = require('../lib/change-log');

const [meetingId, meetingDate, ...flags] = process.argv.slice(2);
if (!meetingId || !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate || '')) {
    console.error('Usage: node scripts/backfill-change-log.js <meetingId> <YYYY-MM-DD> [--write]');
    process.exit(1);
}
const write = flags.includes('--write');
const repoRoot = path.resolve(__dirname, '..', '..');
const relPath = `agenda-scraper/data/meeting_${meetingId}_${meetingDate}.json`;

function git(args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Oldest first: "<sha>\t<author ISO date>"
const commits = git(['log', '--reverse', '--format=%H\t%aI', '--', relPath])
    .trim().split('\n').filter(Boolean)
    .map(line => { const [sha, iso] = line.split('\t'); return { sha, iso }; });

if (!commits.length) {
    console.error(`No commits touch ${relPath}`);
    process.exit(1);
}

const localDate = (iso) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso));

const log = {
    meetingId: String(meetingId),
    meetingDate,
    firstSeenAt: commits[0].iso,
    entries: [],
};

let prev = null;
for (const { sha, iso } of commits) {
    const data = JSON.parse(git(['show', `${sha}:${relPath}`]));
    if (prev) {
        const diff = computeMeetingDiff(prev, data);
        if (!diffIsEmpty(diff)) {
            appendOrMergeEntry(log, {
                scrapedAt: iso,
                agendaTypePromoted: diff.agendaTypePromoted,
                itemsAdded: diff.itemsAdded,
                itemsRemoved: diff.itemsRemoved,
                newDocuments: diff.documentsAdded,
            }, localDate(iso));
        }
    }
    prev = data;
}

for (const e of log.entries) {
    console.log(`${e.date}: promoted=${e.agendaTypePromoted ? `${e.agendaTypePromoted.from}→${e.agendaTypePromoted.to}` : '-'}`
        + ` items+${(e.itemsAdded || []).length} items-${(e.itemsRemoved || []).length} docs+${(e.newDocuments || []).length}`);
    for (const d of e.newDocuments || []) console.log(`    item ${d.itemNumber} (${d.itemFileNumber}): ${d.filename}`);
}

if (write) {
    const existing = loadChangeLog(meetingId, meetingDate);
    if (existing.firstSeenAt && existing.firstSeenAt < log.firstSeenAt) log.firstSeenAt = existing.firstSeenAt;
    saveChangeLog(log);
    console.log(`\nWrote ${log.entries.length} entr${log.entries.length === 1 ? 'y' : 'ies'} to data/changes/meeting_${meetingId}_${meetingDate}.json`);
} else {
    console.log('\n(dry run — pass --write to save)');
}

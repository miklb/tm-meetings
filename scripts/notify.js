#!/usr/bin/env node
/**
 * notify.js — the keyword-notification run for one meeting date, in one command.
 *
 *   npm run notify -- 2026-11-12          preview, then ask before sending
 *   npm run notify -- 2026-11-12 --yes    preview, then send without asking
 *
 * It does by itself what the runbook used to do by hand:
 *   1. finds the meeting IDs for the date in agenda-scraper/data/
 *   2. reads the agenda post URL from agenda-scraper/agendas/agenda_<date>.md
 *   3. checks that post is live and has an #item-<id> anchor for every item
 *   4. runs preview-dispatch.js (read-only) and prints who would get what
 *   5. sends with dispatch-notifications.js, then checks that the server's
 *      sentCount equals the preview's count
 *
 * Nothing is sent when the preview finds nothing new, when a check fails, or
 * when it runs without a terminal and without --yes (that run is a preview).
 *
 * Options:
 *   --yes                      send without the y/N prompt
 *   --agenda-url=<url>         use this post URL (hand-set slug, or no record copy)
 *   --allow-missing-anchors    send although the post lacks some item anchors
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_ROOT, 'agenda-scraper/data');
const RECORD_DIR = path.join(REPO_ROOT, 'agenda-scraper/agendas');
const SITE_ORIGIN = 'https://tampamonitor.com';

/** Meeting IDs whose JSON file is dated `date`, lowest first. */
function meetingIdsForDate(files, date) {
  const re = new RegExp(`^meeting_(\\d+)_${date}\\.json$`);
  return files
    .map(f => (f.match(re) || [])[1])
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));
}

/** The agenda post URL from a record copy's `permalink:` front matter, or null. */
function agendaUrlFromRecord(markdown) {
  const m = markdown.match(/^permalink:\s*"?([^"\n]+?)"?\s*$/m);
  return m ? SITE_ORIGIN + m[1] : null;
}

/** Items the post has no `id="item-<agendaItemId>"` anchor for. */
function missingAnchors(html, meetings) {
  const missing = [];
  for (const meeting of meetings) {
    for (const item of meeting.agendaItems || []) {
      if (!html.includes(`id="item-${item.agendaItemId}"`)) {
        missing.push({ number: item.number, fileNumber: item.fileNumber || '' });
      }
    }
  }
  return missing;
}

/** How many emails the preview says would go out; null if it didn't say. */
function parsePreviewCount(stdout) {
  const m = stdout.match(/would send (\d+) email/);
  if (m) return Number(m[1]);
  return /Nothing would send/.test(stdout) ? 0 : null;
}

/** sentCount from the dispatch response; null if absent. */
function parseSentCount(stdout) {
  const m = stdout.match(/"sentCount":\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** WEBHOOK_SECRET from the text of a .env file, or null. */
function readSecret(envText) {
  const m = envText.match(/^WEBHOOK_SECRET=(.*)$/m);
  return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2') : null;
}

function parseArgs(argv) {
  const opts = { date: null, yes: false, agendaUrl: '', allowMissingAnchors: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--allow-missing-anchors') opts.allowMissingAnchors = true;
    else if (a.startsWith('--agenda-url=')) opts.agendaUrl = a.slice('--agenda-url='.length);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
    else fail(`Unrecognized argument: ${a}`);
  }
  return opts;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function runScript(name, args, env) {
  return spawnSync(process.execPath, [path.join(__dirname, name), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.date) {
    console.log('Usage: npm run notify -- <YYYY-MM-DD> [--yes] [--agenda-url=<url>] [--allow-missing-anchors]');
    process.exit(opts.help ? 0 : 1);
  }

  // 1. Meetings on this date.
  const files = fs.readdirSync(DATA_DIR);
  const ids = meetingIdsForDate(files, opts.date);
  if (ids.length === 0) {
    fail(`no meeting JSON for ${opts.date} in agenda-scraper/data/. Run the agenda for that date first.`);
  }
  const meetings = ids.map(id =>
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, `meeting_${id}_${opts.date}.json`), 'utf8')));
  console.log(`Meetings on ${opts.date}: ${ids.join(', ')}`);

  // 2. The agenda post the digest links to.
  let agendaUrl = opts.agendaUrl;
  if (!agendaUrl) {
    const record = path.join(RECORD_DIR, `agenda_${opts.date}.md`);
    if (fs.existsSync(record)) agendaUrl = agendaUrlFromRecord(fs.readFileSync(record, 'utf8'));
  }
  if (!agendaUrl) {
    fail(`no permalink found in agenda-scraper/agendas/agenda_${opts.date}.md. Pass --agenda-url=<url>.`);
  }
  console.log(`Agenda post: ${agendaUrl}`);

  // 3. The post is live and every item has its deep-link anchor.
  const response = await fetch(agendaUrl);
  if (response.status !== 200) {
    fail(`the agenda post returned HTTP ${response.status}. Publish it first, or pass --agenda-url=<url> if the slug was set by hand.`);
  }
  const missing = missingAnchors(await response.text(), meetings);
  if (missing.length > 0) {
    const list = missing.map(m => `item ${m.number}${m.fileNumber ? ` [${m.fileNumber}]` : ''}`).join(', ');
    console.log(`\nThe live post has no anchor for: ${list}`);
    if (!opts.allowMissingAnchors) {
      fail('the post is behind the agenda data, so some email links would land at the top of the page. Re-run and publish the agenda, or pass --allow-missing-anchors.');
    }
  } else {
    console.log('Post is live; every item has its anchor.');
  }

  // 4. Preview (read-only). The D1 read fails now and then; try twice.
  console.log('');
  const previewArgs = [`--meeting-ids=${ids.join(',')}`];
  let preview = runScript('preview-dispatch.js', previewArgs);
  if (preview.status !== 0) {
    console.log('Preview failed; trying once more...');
    preview = runScript('preview-dispatch.js', previewArgs);
  }
  process.stdout.write(preview.stdout || '');
  if (preview.status !== 0) {
    process.stderr.write(preview.stderr || '');
    fail('the preview failed twice. Nothing sent.');
  }
  const expected = parsePreviewCount(preview.stdout);
  if (expected === null) fail('could not read a count from the preview. Nothing sent.');
  if (expected === 0) {
    console.log('\nNothing new to send.');
    return;
  }

  // 5. Confirm.
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.log('\nPreview only; nothing sent. Re-run with --yes to send.');
      return;
    }
    const answer = await ask(`\nSend ${expected} email(s)? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Nothing sent.');
      return;
    }
  }

  // 6. Send, then hold the server's count against the preview's.
  let secret = process.env.WEBHOOK_SECRET;
  const envFile = path.join(REPO_ROOT, '.env');
  if (!secret && fs.existsSync(envFile)) secret = readSecret(fs.readFileSync(envFile, 'utf8'));
  if (!secret) fail('WEBHOOK_SECRET is not in the environment or in .env. Nothing sent.');

  console.log('');
  const dispatch = runScript('dispatch-notifications.js', [], {
    ...process.env,
    WEBHOOK_SECRET: secret,
    MEETING_IDS: ids.join(','),
    AGENDA_URL: agendaUrl,
  });
  process.stdout.write(dispatch.stdout || '');
  process.stderr.write(dispatch.stderr || '');
  if (dispatch.status !== 0) fail('the dispatch failed. Check the output above before re-running.');

  const sent = parseSentCount(dispatch.stdout);
  if (sent !== expected) {
    fail(`the preview expected ${expected} email(s) and the server reported ${sent}. Find out why before re-running.`);
  }
  console.log(`\nSent ${sent} of ${expected}.`);
}

module.exports = {
  meetingIdsForDate, agendaUrlFromRecord, missingAnchors,
  parsePreviewCount, parseSentCount, readSecret,
};

if (require.main === module) {
  main().catch(err => fail(err.message));
}

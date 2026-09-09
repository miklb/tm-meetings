#!/usr/bin/env node
/**
 * preview-dispatch.js — Dry-run for scripts/dispatch-notifications.js.
 *
 * dispatch-notifications.js has no dry-run: it POSTs straight to production
 * /api/notify and emails every matching verified subscriber. This script
 * answers "who would get what?" first, by mirroring the matching engine in
 * site/functions/api/notify.js against remote D1 — read-only, sends nothing.
 *
 * Takes the same meeting-id args as dispatch-notifications.js, so you can
 * preview and then send with the same arguments.
 *
 * Usage:
 *   node scripts/preview-dispatch.js --meeting-ids=2815
 *   MEETING_IDS=2815 node scripts/preview-dispatch.js
 *
 * Registration mode is read from site/wrangler.toml (the deployed config).
 * Eligibility and matching come from site/lib/keyword-matcher.js — the same
 * module notify.js runs — so this preview cannot drift from the dispatch.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// ESM module; Node >= 22.12 can require() it.
const {
  buildMatchers, matchItem, searchableText, splitMatchKey, itemKey, eligibilityFromRow,
} = require('../site/lib/keyword-matcher.js');

const DB_NAME = 'tampa-meetings-notifications';
const REPO_ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(REPO_ROOT, 'site');

/** REGISTRATION_MODE from site/wrangler.toml (falls back like notify.js). */
function registrationMode() {
  try {
    const toml = fs.readFileSync(path.join(SITE_DIR, 'wrangler.toml'), 'utf8');
    const m = toml.match(/^\s*REGISTRATION_MODE\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  } catch { /* fall through */ }
  return 'SUPPORTERS_ONLY';
}

/** Run a read-only query against remote D1 and return its rows. */
function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json', '--command', sql],
    { cwd: SITE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  // Wrangler may print banner lines before the JSON array.
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output for: ${sql}`);
  return JSON.parse(out.slice(start))[0].results || [];
}

function main() {
  const args = process.argv.slice(2);
  const idsArg = (args.find(a => a.startsWith('--meeting-ids=')) || '').split('=')[1] || '';
  const meetingIds = (idsArg || process.env.MEETING_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (meetingIds.length === 0) {
    console.error('Error: specify meeting IDs via --meeting-ids=<id1,id2> or MEETING_IDS.');
    process.exit(1);
  }

  // Load the same meeting JSON that dispatch-notifications.js would send.
  const dataDir = path.join(REPO_ROOT, 'agenda-scraper/data');
  const allFiles = fs.readdirSync(dataDir);
  const meetings = meetingIds.map(id => {
    const match = allFiles.find(f => new RegExp(`^meeting_${id}_.*\\.json$`).test(f));
    if (!match) {
      console.error(`Error: no meeting JSON found for ID ${id} in ${dataDir}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(path.join(dataDir, match), 'utf8'));
  });

  console.log('Reading remote D1 (read-only)...\n');

  // Mirror notify.js step 3: verified subscribers + supporter/beta status.
  const subRows = d1(`
    SELECT s.id AS sub_id, s.email,
           sup.email AS supporter_email, sup.active_until AS supporter_active_until,
           CASE WHEN bt.email IS NOT NULL THEN 1 ELSE 0 END AS is_beta_tester
    FROM subscriptions s
    LEFT JOIN supporters sup ON s.email = sup.email
    LEFT JOIN beta_testers bt ON s.email = bt.email
    WHERE s.verified = 1;`.replace(/\s+/g, ' '));

  // Mirror step 4: eligibility + keyword limit for the deployed registration mode.
  const regMode = registrationMode();
  const now = new Date();
  const allowed = [];
  for (const r of subRows) {
    const e = eligibilityFromRow(r, regMode, now);
    if (e.allowed) allowed.push({ ...r, limit: e.limit });
    else console.log(`Not eligible in ${regMode} mode (would not send): ${r.email}`);
  }
  console.log(`Registration mode: ${regMode} — ${allowed.length} of ${subRows.length} verified subscriber(s) eligible\n`);

  if (allowed.length === 0) {
    console.log('No verified subscribers meet the registration-mode requirements. Nothing would send.');
    return;
  }

  // Mirror step 5: keywords ordered by id, truncated to the per-subscriber limit.
  const kwRows = d1(
    'SELECT id, subscription_id, keyword, match_type FROM keywords ORDER BY id ASC;'
  );
  const kwBySub = {};
  for (const k of kwRows) {
    (kwBySub[k.subscription_id] ||= []).push(k);
  }

  // Already-notified triples, so we only report what would actually send.
  const logRows = d1(
    'SELECT subscription_id, agenda_item_id, keyword_matched FROM notification_log;'
  );
  const sent = new Set(
    logRows.map(l => `${l.subscription_id}:${l.agenda_item_id}:${l.keyword_matched}`)
  );

  let wouldEmail = 0;

  for (const sub of allowed) {
    const keywords = (kwBySub[sub.sub_id] || []).slice(0, sub.limit)
      .map(k => ({ keyword: k.keyword.trim().toLowerCase(), matchType: k.match_type }));
    const matchers = buildMatchers(keywords);
    const perKeyword = new Map(keywords.map(k => [k.keyword, []]));
    const fresh = [];   // would send now
    const dedup = [];   // matched, but already emailed

    for (const meeting of meetings) {
      for (const item of meeting.agendaItems || []) {
        const text = searchableText(item);
        const hits = [...matchItem(item, matchers, text)].map(key => splitMatchKey(key).keyword);
        for (const kw of hits) {
          perKeyword.get(kw)?.push(item.number);
          const rec = { number: item.number, fileNumber: item.fileNumber, kw };
          if (sent.has(`${sub.sub_id}:${itemKey(item)}:${kw}`)) dedup.push(rec);
          else fresh.push(rec);
        }
      }
    }

    // notify.js only emails a subscriber who has at least one un-sent match.
    const freshItems = [...new Set(fresh.map(f => f.number))];
    if (freshItems.length > 0) wouldEmail += 1;

    console.log(`=== ${sub.email} ===`);
    if (freshItems.length === 0) {
      console.log(dedup.length
        ? `  no NEW matches (${dedup.length} already sent) — would receive NO email`
        : '  no matches — would receive NO email');
    } else {
      console.log(`  WOULD EMAIL — ${freshItems.length} item(s):`);
      for (const n of freshItems) {
        const kws = [...new Set(fresh.filter(f => f.number === n).map(f => f.kw))];
        const fn = fresh.find(f => f.number === n).fileNumber;
        console.log(`    item ${n} [${fn}] via: ${kws.join(', ')}`);
      }
      if (dedup.length) {
        const dn = [...new Set(dedup.map(d => d.number))];
        console.log(`  (already sent, suppressed: item ${dn.join(', ')})`);
      }
    }

    // Dead keywords are the quiet failure mode: an over-specific phrase that
    // never appears verbatim in the agenda matches nothing, and nothing says so.
    const dead = [...perKeyword.entries()].filter(([, v]) => v.length === 0).map(([k]) => k);
    if (dead.length) {
      console.log(`  zero-match keywords: ${dead.map(k => `"${k}"`).join(', ')}`);
    }
    console.log('');
  }

  console.log(`Summary: dispatch would send ${wouldEmail} email(s) (expect "sentCount":${wouldEmail}).`);
}

main();

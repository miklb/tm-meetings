// Tests for pipeline/git-sync.sh — run with `npm test` (node --test).
//
// Each test builds a bare "origin" plus two clones ("work" = the pipeline
// machine, "other" = the nightly) in a temp dir, sources the helper in a bash
// subprocess and asserts on git state afterwards. Pathspec scoping matters
// most: a run must commit only the files it wrote and leave everything else
// (other dates, unrelated edits) untouched.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const HELPER = path.resolve(__dirname, '..', '..', 'pipeline', 'git-sync.sh');

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configure(repo) {
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
}

function writeFile(repo, rel, content) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

function commitAll(repo, message) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
}

/** Bare origin seeded with one commit, plus two clones of it. */
function makeRepos() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-test-'));
    const origin = path.join(base, 'origin.git');
    const work = path.join(base, 'work');
    const other = path.join(base, 'other');
    git(base, 'init', '-q', '--bare', '--initial-branch=main', origin);
    git(base, 'clone', '-q', origin, work);
    configure(work);
    git(work, 'checkout', '-q', '-b', 'main');
    writeFile(work, 'README', 'seed\n');
    writeFile(work, 'transcript-cleaner/processor/data/video_mapping_9999.json', '{"seed":true}\n');
    commitAll(work, 'seed');
    git(work, 'push', '-q', '-u', 'origin', 'main');
    git(base, 'clone', '-q', origin, other);
    configure(other);
    return { base, origin, work, other };
}

/** Source the helper and run one function; returns {status, out}. */
function runSync(cwd, call, env = {}) {
    const res = spawnSync('bash', ['-c', `set -euo pipefail; source "${HELPER}"; ${call}`], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function committedFiles(repo, ref = 'HEAD') {
    return git(repo, 'show', '--name-only', '--format=', ref).split('\n').filter(Boolean).sort();
}

function untracked(repo) {
    return git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

/** A full agenda run's output for one date, plus files that must be left alone. */
function writeAgendaRun(repo, date) {
    writeFile(repo, `agenda-scraper/data/meeting_1_${date}.json`, '{"items":1}\n');
    writeFile(repo, `agenda-scraper/data/changes/meeting_1_${date}.json`, '{"changes":[]}\n');
    writeFile(repo, `agenda-scraper/data/locations/1-${date}-locations.json`, '{}\n');
    writeFile(repo, `agenda-scraper/agendas/agenda_${date}.md`, '# agenda\n');
}

test('short_date matches the commit-message convention', () => {
    const { work } = makeRepos();
    assert.equal(runSync(work, 'short_date 2026-10-01').out.trim(), '10/1/26');
    assert.equal(runSync(work, 'short_date 2026-09-24').out.trim(), '9/24/26');
    assert.equal(runSync(work, 'short_date 2026-11-19').out.trim(), '11/19/26');
});

test('start: in sync is a no-op that succeeds', () => {
    const { work } = makeRepos();
    const r = runSync(work, 'git_sync_start');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /In sync with origin\/main/);
});

test('start: behind origin fast-forwards', () => {
    const { work, other } = makeRepos();
    writeFile(other, 'agenda-scraper/data/meeting_2_2026-10-08.json', '{"nightly":1}\n');
    commitAll(other, 'nightly');
    git(other, 'push', '-q', 'origin', 'main');
    const r = runSync(work, 'git_sync_start');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Fast-forwarded/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
});

test('start: ahead of origin proceeds and says so', () => {
    const { work } = makeRepos();
    writeFile(work, 'agenda-scraper/agendas/agenda_2026-10-01.md', '# local\n');
    commitAll(work, 'local only');
    const r = runSync(work, 'git_sync_start');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Ahead of origin\/main by 1 commit/);
});

test('start: diverged refuses to run and changes nothing', () => {
    const { work, other } = makeRepos();
    writeFile(other, 'agenda-scraper/data/meeting_2_2026-10-08.json', '{"nightly":1}\n');
    commitAll(other, 'nightly');
    git(other, 'push', '-q', 'origin', 'main');
    writeFile(work, 'agenda-scraper/agendas/agenda_2026-10-01.md', '# local\n');
    commitAll(work, 'local');
    const before = git(work, 'rev-parse', 'HEAD');
    const r = runSync(work, 'git_sync_start');
    assert.equal(r.status, 1);
    assert.match(r.out, /diverged/);
    assert.match(r.out, /git pull/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
});

test('start: a dirty index is refused so the run commit stays clean', () => {
    const { work } = makeRepos();
    writeFile(work, 'notes.txt', 'wip\n');
    git(work, 'add', 'notes.txt');
    const r = runSync(work, 'git_sync_start');
    assert.equal(r.status, 1);
    assert.match(r.out, /staged changes/);
});

test('start: SYNC=false and DRY_RUN=true touch nothing', () => {
    const { work, other } = makeRepos();
    writeFile(other, 'x.txt', 'x\n');
    commitAll(other, 'nightly');
    git(other, 'push', '-q', 'origin', 'main');
    const before = git(work, 'rev-parse', 'HEAD');
    const off = runSync(work, 'git_sync_start', { SYNC: 'false' });
    assert.equal(off.status, 0, off.out);
    assert.match(off.out, /skipped/);
    const dry = runSync(work, 'git_sync_start', { DRY_RUN: 'true' });
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /\[dry-run\]/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
});

test('finish_agenda: commits only that date\'s files, with the convention message, and pushes', () => {
    const { work, origin } = makeRepos();
    writeAgendaRun(work, '2026-10-01');
    writeFile(work, 'agenda-scraper/data/meeting_2_2026-10-08.json', '{"other date":1}\n');
    writeFile(work, 'notes.txt', 'unrelated\n');
    const r = runSync(work, 'git_sync_finish_agenda 2026-10-01');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Pushed to origin\/main/);
    assert.equal(git(work, 'log', '-1', '--format=%s'), 'update 10/1/26 agenda');
    assert.deepEqual(committedFiles(work), [
        'agenda-scraper/agendas/agenda_2026-10-01.md',
        'agenda-scraper/data/changes/meeting_1_2026-10-01.json',
        'agenda-scraper/data/locations/1-2026-10-01-locations.json',
        'agenda-scraper/data/meeting_1_2026-10-01.json',
    ]);
    assert.deepEqual(untracked(work), [
        '?? agenda-scraper/data/meeting_2_2026-10-08.json',
        '?? notes.txt',
    ]);
    assert.equal(git(origin, 'rev-parse', 'main'), git(work, 'rev-parse', 'HEAD'));
});

test('finish_agenda: a modified tracked file and a deleted file are both picked up', () => {
    const { work } = makeRepos();
    writeAgendaRun(work, '2026-10-01');
    runSync(work, 'git_sync_finish_agenda 2026-10-01');
    writeFile(work, 'agenda-scraper/data/meeting_1_2026-10-01.json', '{"items":2}\n');
    fs.unlinkSync(path.join(work, 'agenda-scraper/data/locations/1-2026-10-01-locations.json'));
    const r = runSync(work, 'git_sync_finish_agenda 2026-10-01');
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(committedFiles(work), [
        'agenda-scraper/data/locations/1-2026-10-01-locations.json',
        'agenda-scraper/data/meeting_1_2026-10-01.json',
    ]);
    assert.deepEqual(untracked(work), []);
});

test('finish: nothing to commit and nothing to push is a clean no-op', () => {
    const { work } = makeRepos();
    const before = git(work, 'rev-parse', 'HEAD');
    const r = runSync(work, 'git_sync_finish_agenda 2026-10-01');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /nothing new to commit/);
    assert.match(r.out, /Nothing to push/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
});

test('finish: an earlier unpushed commit is pushed even when this run wrote nothing', () => {
    const { work, origin } = makeRepos();
    writeFile(work, 'agenda-scraper/agendas/agenda_2026-09-24.md', '# earlier\n');
    commitAll(work, 'archive 9/24/26');
    const r = runSync(work, 'git_sync_finish_agenda 2026-10-01');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Pushed/);
    assert.equal(git(origin, 'rev-parse', 'main'), git(work, 'rev-parse', 'HEAD'));
});

test('finish: SYNC=false and DRY_RUN=true commit nothing', () => {
    const { work } = makeRepos();
    writeAgendaRun(work, '2026-10-01');
    const before = git(work, 'rev-parse', 'HEAD');
    const off = runSync(work, 'git_sync_finish_agenda 2026-10-01', { SYNC: 'false' });
    assert.equal(off.status, 0, off.out);
    const dry = runSync(work, 'git_sync_finish_agenda 2026-10-01', { DRY_RUN: 'true' });
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /\[dry-run\] would commit "update 10\/1\/26 agenda" \(2 pathspec/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
    assert.equal(untracked(work).length, 4);
});

test('finish: refuses to commit over a dirty index', () => {
    const { work } = makeRepos();
    writeAgendaRun(work, '2026-10-01');
    writeFile(work, 'notes.txt', 'wip\n');
    git(work, 'add', 'notes.txt');
    const before = git(work, 'rev-parse', 'HEAD');
    const r = runSync(work, 'git_sync_finish_agenda 2026-10-01');
    assert.equal(r.status, 1);
    assert.match(r.out, /staged changes/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before);
});

test('finish: a failed push leaves the commit in place and exits 1', () => {
    const { work } = makeRepos();
    writeAgendaRun(work, '2026-10-01');
    git(work, 'remote', 'set-url', 'origin', path.join(work, 'does-not-exist.git'));
    const r = runSync(work, 'git_sync_finish_agenda 2026-10-01');
    assert.equal(r.status, 1);
    assert.match(r.out, /push failed/);
    assert.equal(git(work, 'log', '-1', '--format=%s'), 'update 10/1/26 agenda');
});

test('finish_archive: agenda files, both transcripts and only the named pkeys\' mappings', () => {
    const { work } = makeRepos();
    const date = '2026-09-24';
    writeFile(work, `agenda-scraper/agendas/agenda_${date}.md`, '# final check\n');
    writeFile(work, `transcript-cleaner/processor/data/transcripts/transcript_2706_${date}.json`, '[]\n');
    writeFile(work, `transcript-cleaner/processor/data/transcripts/transcript_2707_${date}.json`, '[]\n');
    writeFile(work, `transcript-cleaner/processor/data/processed/processed_transcript_2706_${date}.json`, '[]\n');
    writeFile(work, `transcript-cleaner/processor/data/processed/processed_transcript_2707_${date}.json`, '[]\n');
    writeFile(work, 'transcript-cleaner/processor/data/video_mapping_2706.json', '{}\n');
    writeFile(work, 'transcript-cleaner/processor/data/video_mapping_2707.json', '{}\n');
    // A hand-edited mapping for some other meeting must not be swept up.
    writeFile(work, 'transcript-cleaner/processor/data/video_mapping_9999.json', '{"seed":false}\n');
    const r = runSync(work, `git_sync_finish_archive ${date} 2706 2707`);
    assert.equal(r.status, 0, r.out);
    assert.equal(git(work, 'log', '-1', '--format=%s'), 'archive 9/24/26');
    assert.deepEqual(committedFiles(work), [
        `agenda-scraper/agendas/agenda_${date}.md`,
        `transcript-cleaner/processor/data/processed/processed_transcript_2706_${date}.json`,
        `transcript-cleaner/processor/data/processed/processed_transcript_2707_${date}.json`,
        `transcript-cleaner/processor/data/transcripts/transcript_2706_${date}.json`,
        `transcript-cleaner/processor/data/transcripts/transcript_2707_${date}.json`,
        'transcript-cleaner/processor/data/video_mapping_2706.json',
        'transcript-cleaner/processor/data/video_mapping_2707.json',
    ]);
    assert.deepEqual(untracked(work), ['M transcript-cleaner/processor/data/video_mapping_9999.json']);
});

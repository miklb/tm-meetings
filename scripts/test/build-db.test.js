// Tests for scripts/build-db.js — run with `npm test` (node --test).
//
// Each test builds a database from a small synthetic fixture tree
// (agenda JSON + processed transcripts + video mappings) in a temp dir and
// asserts on the resulting SQLite rows and on the build log.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { buildDatabase } = require('../build-db.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-db-test-'));
  const dataDir = path.join(root, 'agenda');
  const transcriptDir = path.join(root, 'transcripts');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(path.join(transcriptDir, 'processed'), { recursive: true });
  const output = path.join(root, 'out', 'meetings.db');
  const logs = [];
  const log = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
  };

  const item = (agendaItemId, fileNumber, extra = {}) => ({
    agendaItemId: String(agendaItemId),
    number: extra.number ?? agendaItemId,
    fileNumber,
    title: `File No. ${fileNumber} Item ${agendaItemId}`,
    supportingDocuments: extra.docs || [],
    ...extra,
  });

  return {
    root, dataDir, transcriptDir, output, logs,
    item,

    /** Write meeting_<id>_<date>.json */
    meeting({ id, date, type = 'regular', name = null, agendaType = 'FINAL', isAddendum, items = [] }) {
      const data = {
        meetingId: String(id),
        meetingType: type,
        meetingName: name,
        agendaType,
        meetingDate: date,
        formattedDate: date,
        sourceUrl: `https://example.test/${id}`,
        agendaItems: items,
      };
      if (isAddendum !== undefined) data.isAddendum = isAddendum;
      fs.writeFileSync(path.join(dataDir, `meeting_${id}_${date}.json`), JSON.stringify(data));
      return data;
    },

    /** Write processed/processed_transcript_<id>_<date>.json */
    transcript({ id, date, title = 'TAMPA CITY COUNCIL', time = '9:00 A.M.', segments = 2 }) {
      const segs = Array.isArray(segments) ? segments : Array.from({ length: segments }, (_, i) => ({
        timestamp: `9:0${i}:00AM`, speaker: 'CHAIR', text: `Segment ${i} of ${id}`,
      }));
      const data = {
        meeting_id: String(id),
        meeting_title: title,
        meeting_date_time: `${date}, ${time}`,
        segments: segs,
      };
      fs.writeFileSync(
        path.join(transcriptDir, 'processed', `processed_transcript_${id}_${date}.json`),
        JSON.stringify(data)
      );
    },

    /** Write video_mapping_<id>.json */
    mapping({ id, date, type = 'City Council', videos = 1, verification }) {
      const data = {
        meeting_id: id,
        meeting_date: date,
        meeting_type: type,
        videos: Array.from({ length: videos }, (_, i) => ({
          video_id: `vid${id}p${i + 1}`, title: `Video ${id}`, part: i + 1,
          offset_seconds: 60, chapters: [{ title: 'Start', timestamp: '00:00:00', seconds: 0 }],
        })),
      };
      if (verification) data.verification = verification;
      fs.writeFileSync(path.join(transcriptDir, `video_mapping_${id}.json`), JSON.stringify(data));
    },

    build(extra = {}) {
      logs.length = 0;
      return buildDatabase({ dataDir, transcriptDir, output, log, transcriptMeetingOverrides: {}, ...extra });
    },

    open() {
      return new Database(output, { readonly: true });
    },

    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const q = (db, sql, ...params) => db.prepare(sql).all(...params);
const one = (db, sql, ...params) => db.prepare(sql).get(...params);

// ---------------------------------------------------------------------------
// Addenda and same-day meetings
// ---------------------------------------------------------------------------

test('a flagged addendum folds into its parent meeting instead of becoming a meeting', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 100, date: '2026-03-05', name: 'City Council Regular', items: [
    f.item(1, 'CM26-1'), f.item(2, 'CM26-2'), f.item(3, 'CM26-3'),
  ] });
  f.meeting({ id: 150, date: '2026-03-05', name: 'City Council Regular Addendum', agendaType: 'DRAFT', isAddendum: true, items: [
    f.item(2, 'CM26-2', { addendumSection: 'removedFromConsent' }),
    f.item(9, 'CM26-9', { addendumSection: 'walkons', continuedToDate: 'March 19, 2026' }),
  ] });

  const stats = f.build();
  const db = f.open();

  assert.equal(stats.meetings, 1);
  assert.equal(stats.addendaFolded, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM meetings').n, 1, 'addendum is not a meeting row');
  const parent = one(db, 'SELECT * FROM meetings WHERE id = 100');
  assert.equal(parent.item_count, 5, 'item_count includes folded items');
  assert.deepEqual(JSON.parse(parent.addendum_ids), [150]);

  const folded = q(db, 'SELECT * FROM agenda_items WHERE meeting_id = 100 AND from_addendum = 1 ORDER BY id');
  assert.equal(folded.length, 2);
  assert.equal(folded[0].addendum_meeting_id, 150);
  assert.equal(folded[0].addendum_section, 'removedFromConsent');
  assert.equal(folded[1].addendum_section, 'walkons');
  assert.equal(folded[1].continued_to_date, 'March 19, 2026');
  assert.equal(q(db, 'SELECT * FROM agenda_items WHERE meeting_id = 100 AND from_addendum = 0').length, 3);
  db.close();
});

test('an unflagged addendum is recognised when all its item ids are on a larger same-day agenda', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 200, date: '2025-12-18', items: [f.item(1, 'CM25-1'), f.item(2, 'CM25-2'), f.item(3, 'CM25-3')] });
  // Old-style scrape: no isAddendum, no meetingName, DRAFT, re-lists two parent items.
  f.meeting({ id: 260, date: '2025-12-18', name: undefined, agendaType: 'DRAFT', items: [f.item(1, 'CM25-1'), f.item(3, 'CM25-3')] });

  const stats = f.build();
  const db = f.open();

  assert.equal(stats.addendaFolded, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM meetings').n, 1);
  assert.equal(one(db, 'SELECT item_count FROM meetings WHERE id = 200').item_count, 5);
  assert.ok(f.logs.some((l) => /260 .*treated as an addendum/.test(l)), 'build log explains the decision');
  db.close();
});

test('the same meeting scraped twice under a new id is reported and not imported', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  const items = [f.item(1, 'CM26-1'), f.item(2, 'CM26-2')];
  f.meeting({ id: 300, date: '2026-04-02', items });
  f.meeting({ id: 390, date: '2026-04-02', items });

  const stats = f.build();
  const db = f.open();

  assert.equal(stats.duplicates, 1);
  assert.deepEqual(q(db, 'SELECT id FROM meetings').map((r) => r.id), [300], 'the earlier scrape is kept');
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM agenda_items').n, 2, 'nothing was merged');
  assert.ok(f.logs.some((l) => /390 .*duplicate scrape/.test(l)));
  db.close();
});

test('two distinct meetings on the same day with the same type are both kept', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 2629, date: '2025-08-11', name: 'City Council Special Call Budget Workshop', items: [
    f.item(10, 'B2026-2'), f.item(11, 'CM25-1'), f.item(12, 'CM25-2'),
  ] });
  f.meeting({ id: 2670, date: '2025-08-11', name: 'City Council Special Call Budget Workshop', items: [f.item(20, 'B2026-2')] });

  const stats = f.build();
  const db = f.open();

  assert.equal(stats.meetings, 2);
  assert.equal(stats.addendaFolded, 0);
  assert.equal(stats.duplicates, 0);
  assert.deepEqual(q(db, 'SELECT id FROM meetings ORDER BY id').map((r) => r.id), [2629, 2670]);
  assert.ok(f.logs.some((l) => /2 regular meetings on 2025-08-11 .*kept all/.test(l)));
  db.close();
});

test('an addendum with no parent on its date is imported as its own meeting', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 400, date: '2026-05-01', isAddendum: true, name: 'City Council Addendum', items: [f.item(1, 'CM26-1')] });

  const stats = f.build();
  const db = f.open();

  assert.equal(stats.addendaStandalone, 1);
  const row = one(db, 'SELECT * FROM meetings WHERE id = 400');
  assert.equal(row.agenda_type, 'ADDENDUM');
  assert.ok(f.logs.some((l) => /Addendum 400 .*no parent meeting/.test(l)));
  db.close();
});

test('an addendum whose type infers differently still finds the only meeting on its date', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  // Evening meeting (zoning prefixes) and an evening addendum with a bare
  // resolution and no file number, which infers as 'regular'.
  f.meeting({ id: 500, date: '2026-06-11', type: 'evening', items: [f.item(1, 'REZ-26-1'), f.item(2, 'REZ-26-2'), f.item(3, 'TA/CPA26-1')] });
  f.meeting({ id: 560, date: '2026-06-11', type: 'regular', isAddendum: true, items: [{ agendaItemId: '77', number: 1, title: 'Resolution of the City Council', fileNumber: null }] });

  f.build();
  const db = f.open();
  assert.equal(one(db, 'SELECT meeting_type FROM meetings WHERE id = 500').meeting_type, 'evening');
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM agenda_items WHERE meeting_id = 500 AND from_addendum = 1').n, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Transcript matching
// ---------------------------------------------------------------------------

test('a transcript matches its agenda meeting by date and type', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 600, date: '2026-02-05', items: [f.item(1, 'CM26-1')] });
  f.transcript({ id: 6000, date: '2026-02-05' });

  f.build();
  const db = f.open();
  assert.equal(one(db, 'SELECT transcript_source_id FROM meetings WHERE id = 600').transcript_source_id, '6000');
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM transcript_segments WHERE meeting_id = 600').n, 2);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM meetings WHERE id >= 1000000').n, 0, 'no stub');
  db.close();
});

test('two transcripts and two indistinguishable agendas on one date are logged as ambiguous, not guessed', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 2629, date: '2025-08-11', items: [f.item(10, 'B2026-2'), f.item(11, 'CM25-1')] });
  f.meeting({ id: 2670, date: '2025-08-11', items: [f.item(20, 'B2026-2')] });
  f.transcript({ id: 2624, date: '2025-08-11', title: 'TAMPA CITY COUNCIL SPECIAL CALL BUDGET WORKSHOP', time: '9:00 A.M.' });
  f.transcript({ id: 2623, date: '2025-08-11', title: 'TAMPA CITY COUNCIL BUDGET WORKSHOP', time: '5:01 P.M.' });

  f.build();
  const db = f.open();
  assert.deepEqual(
    q(db, 'SELECT id FROM meetings WHERE id >= 1000000 ORDER BY id').map((r) => r.id),
    [1002623, 1002624],
    'both transcripts become stubs rather than one being paired by guess'
  );
  assert.equal(f.logs.filter((l) => /is ambiguous: 2 unclaimed agenda meetings/.test(l)).length, 2);
  db.close();
});

test('transcriptMeetingOverrides pairs an ambiguous date and refines the agenda type', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 2629, date: '2025-08-11', items: [f.item(10, 'B2026-2'), f.item(11, 'CM25-1')] });
  f.meeting({ id: 2670, date: '2025-08-11', items: [f.item(20, 'B2026-2')] });
  f.transcript({ id: 2624, date: '2025-08-11', title: 'TAMPA CITY COUNCIL SPECIAL CALL BUDGET WORKSHOP' });
  f.transcript({ id: 2623, date: '2025-08-11', title: 'TAMPA CITY COUNCIL BUDGET WORKSHOP' });

  f.build({ transcriptMeetingOverrides: { '2624': 2629, '2623': 2670 } });
  const db = f.open();
  const rows = q(db, 'SELECT id, meeting_type, transcript_source_id FROM meetings ORDER BY id');
  assert.deepEqual(rows, [
    { id: 2629, meeting_type: 'workshop', transcript_source_id: '2624' },
    { id: 2670, meeting_type: 'workshop', transcript_source_id: '2623' },
  ]);
  db.close();
});

test('an empty transcript never claims a meeting', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 700, date: '2026-04-09', items: [f.item(1, 'CM26-1')] });
  f.transcript({ id: 7000, date: '2026-04-09', segments: [] });

  f.build();
  const db = f.open();
  assert.equal(one(db, 'SELECT transcript_source_id FROM meetings WHERE id = 700').transcript_source_id, null);
  db.close();
});

// ---------------------------------------------------------------------------
// Videos and offset verification
// ---------------------------------------------------------------------------

test('a video mapping whose verification failed contributes no videos but the transcript still imports', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 800, date: '2026-08-27', items: [f.item(1, 'CM26-1')] });
  f.transcript({ id: 8000, date: '2026-08-27' });
  f.mapping({ id: 8000, date: '2026-08-27', videos: 2, verification: { status: 'fail', checked_at: '2026-08-28T00:00:00Z' } });

  f.build();
  const db = f.open();
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM videos WHERE meeting_id = 800').n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM transcript_segments WHERE meeting_id = 800').n, 2);
  assert.ok(f.logs.some((l) => /Skipping videos for transcript 8000 .*verification failed/.test(l)));
  db.close();
});

test('passing, skipped and unrecorded verifications all import videos', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  for (const [id, date, verification] of [
    [810, '2026-01-08', { status: 'pass' }],
    [820, '2026-01-15', { status: 'skipped' }],
    [830, '2026-01-22', undefined],
  ]) {
    f.meeting({ id, date, items: [f.item(id, `CM26-${id}`)] });
    f.transcript({ id: id * 10, date });
    f.mapping({ id: id * 10, date, verification });
  }

  f.build();
  const db = f.open();
  assert.equal(one(db, 'SELECT COUNT(DISTINCT meeting_id) AS n FROM videos').n, 3);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM video_chapters').n, 3);
  db.close();
});

// ---------------------------------------------------------------------------
// Year filter, atomic output, how the site opens it
// ---------------------------------------------------------------------------

test('--year keeps every table to that year, including transcripts and videos', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  for (const [id, date] of [[900, '2025-10-09'], [910, '2026-02-12']]) {
    f.meeting({ id, date, items: [f.item(id, `CM-${id}`)] });
    f.transcript({ id: id * 10, date });
    f.mapping({ id: id * 10, date });
  }
  // A 2025 transcript with no agenda would become a stub in a full build.
  f.transcript({ id: 9999, date: '2025-11-06' });

  f.build({ year: '2026' });
  const db = f.open();
  assert.deepEqual(q(db, 'SELECT id FROM meetings').map((r) => r.id), [910]);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM transcript_segments').n, 2);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM videos').n, 1);
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM meetings WHERE id >= 1000000').n, 0, 'no cross-year stubs');
  db.close();
});

test('a failed build leaves the previous database untouched and no scratch file behind', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 1000, date: '2026-03-12', items: [f.item(1, 'CM26-1')] });
  f.transcript({ id: 10000, date: '2026-03-12' });
  f.build();
  const before = fs.readFileSync(f.output);

  // A segment whose text is an object cannot be bound by SQLite: the
  // transaction throws part-way through the build.
  f.transcript({ id: 10001, date: '2026-03-12', segments: [{ timestamp: '9:00:00AM', speaker: 'X', text: { bad: true } }] });
  assert.throws(() => f.build(), /parameter|bind|SQLite/i);

  assert.deepEqual(fs.readFileSync(f.output), before, 'previous database is byte-identical');
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)).sort(), ['meetings.db'], 'no .building or sidecar files');
});

test('the output opens read-only in WAL mode, the way the site build opens it', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  f.meeting({ id: 1100, date: '2026-07-16', items: [f.item(1, 'CM26-1')] });
  f.build();

  const db = new Database(f.output, { readonly: true });
  assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
  assert.equal(one(db, 'SELECT COUNT(*) AS n FROM meetings').n, 1);
  db.close();
});

test('a data directory with no meeting files is an error, not an empty database', (t) => {
  const f = makeFixture(); t.after(() => f.cleanup());
  assert.throws(() => f.build(), /No meeting JSON files/);
  assert.equal(fs.existsSync(f.output), false);
});

#!/usr/bin/env node
/**
 * Build SQLite database from agenda JSON files.
 *
 * Usage:
 *   node scripts/build-db.js              # Import all meetings
 *   node scripts/build-db.js --year 2026  # Import only 2026 meetings
 *
 * Reads JSON from agenda-scraper/data/ and writes to data/meetings.db.
 * Idempotent — drops and recreates tables on each run.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const glob = require('glob');

const DATA_DIR = path.resolve(__dirname, '..', 'agenda-scraper', 'data');
const DB_PATH = path.resolve(__dirname, '..', 'data', 'meetings.db');
const TRANSCRIPT_DIR = path.resolve(__dirname, '..', 'transcript-cleaner', 'processor', 'data');
const PROCESSED_DIR = path.join(TRANSCRIPT_DIR, 'processed');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  meeting_type TEXT NOT NULL,
  title TEXT,
  agenda_type TEXT,
  source_url TEXT,
  item_count INTEGER DEFAULT 0,
  transcript_source_id TEXT
);

CREATE TABLE IF NOT EXISTS agenda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  item_number INTEGER,
  agenda_item_id TEXT,
  file_number TEXT,
  title TEXT,
  background TEXT,
  location TEXT,
  coordinates TEXT,
  dollar_amounts TEXT,
  fiscal_expenditures REAL DEFAULT 0,
  fiscal_revenues REAL DEFAULT 0,
  fiscal_net REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agenda_item_id INTEGER NOT NULL REFERENCES agenda_items(id),
  title TEXT,
  source_url TEXT,
  mirrored_url TEXT,
  original_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_agenda_items_meeting ON agenda_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_agenda_items_file_number ON agenda_items(file_number);
CREATE INDEX IF NOT EXISTS idx_documents_item ON documents(agenda_item_id);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  segment_index INTEGER NOT NULL,
  timestamp TEXT,
  speaker TEXT,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  video_id TEXT NOT NULL,
  title TEXT,
  part INTEGER DEFAULT 1,
  session TEXT,
  published_at TEXT,
  duration TEXT,
  offset_seconds INTEGER DEFAULT 0,
  transcript_start_time TEXT
);

CREATE TABLE IF NOT EXISTS video_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_db_id INTEGER NOT NULL REFERENCES videos(id),
  chapter_index INTEGER NOT NULL,
  title TEXT,
  timestamp TEXT,
  seconds INTEGER
);

CREATE INDEX IF NOT EXISTS idx_segments_meeting ON transcript_segments(meeting_id);
CREATE INDEX IF NOT EXISTS idx_videos_meeting ON videos(meeting_id);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map video_mapping.meeting_type values → meetings.meeting_type slugs.
 * The video mapping uses display names; the DB uses slug form.
 */
const VIDEO_MEETING_TYPE_MAP = {
  'city council': 'regular',
  'workshop': 'workshop',
  'evening': 'evening',
  'cra': 'cra',
  'special': 'special',
};

/** Map meetingType from JSON to a human-readable title. */
const TYPE_LABELS = {
  regular: 'City Council',
  evening: 'Evening Session',
  cra: 'CRA',
  workshop: 'Workshop',
  special: 'Special Meeting',
};

// File number prefixes that indicate evening sessions (zoning/public hearings)
const EVENING_PREFIXES = new Set(['REZ', 'TA', 'VAC', 'AB']);

/**
 * Infer meeting_type from agenda item file number prefixes.
 * OnBase labels everything "regular"; the actual type is revealed by
 * what kind of business appears on the agenda.
 */
function inferTypeFromItems(items) {
  if (!items || items.length === 0) return 'regular';

  const prefixes = {};
  for (const item of items) {
    const fn = item.fileNumber || '';
    const m = fn.match(/^([A-Z]+)/);
    if (m) prefixes[m[1]] = (prefixes[m[1]] || 0) + 1;
  }

  const total = Object.values(prefixes).reduce((a, b) => a + b, 0);
  if (total === 0) return 'regular';

  // All CRA → cra
  if (prefixes.CRA && prefixes.CRA === total) return 'cra';
  // Majority CRA → cra
  if (prefixes.CRA && prefixes.CRA / total > 0.6) return 'cra';

  // Evening: dominated by zoning prefixes (REZ, TA, VAC, AB)
  const eveningCount = ['REZ', 'TA', 'VAC', 'AB'].reduce((s, p) => s + (prefixes[p] || 0), 0);
  if (eveningCount / total > 0.6) return 'evening';

  return 'regular';
}

/**
 * Derive a formatted YYYY-MM-DD date from the JSON.
 * Prefers formattedDate, falls back to parsing meetingDate string,
 * falls back to extracting from the filename.
 */
function resolveDate(data, filename) {
  if (data.formattedDate) return data.formattedDate;

  // Try parsing the human-readable date
  if (data.meetingDate) {
    const d = new Date(data.meetingDate);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  }

  // Extract from filename: meeting_2785_2026-03-05.json
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Manual type overrides for transcripts where automatic inference fails.
 * Keys are transcript meeting IDs as strings.
 */
const TRANSCRIPT_TYPE_OVERRIDES = {
  '2645': 'cra', // 2025-11-13 CRA meeting — no type indicators in video mapping or title
};

/**
 * Infer the agenda meeting_type slug from processed transcript data and its
 * corresponding video mapping (if available).
 *
 * Priority:
 *   1. Manual TRANSCRIPT_TYPE_OVERRIDES (for known edge cases)
 *   2. video_mapping.meeting_type (most reliable when present)
 *   3. transcript meeting_title text ("WORKSHOPS" → workshop, etc.)
 *   4. time-of-day in meeting_date_time (5 PM-ish → evening)
 *   5. default → 'regular'
 */
function inferMeetingType(transcriptData, videoMapping) {
  const transcriptId = String(transcriptData.meeting_id ?? '');
  if (TRANSCRIPT_TYPE_OVERRIDES[transcriptId]) {
    return TRANSCRIPT_TYPE_OVERRIDES[transcriptId];
  }
  if (videoMapping?.meeting_type) {
    const key = videoMapping.meeting_type.toLowerCase();
    return VIDEO_MEETING_TYPE_MAP[key] ?? 'regular';
  }
  const title = (transcriptData.meeting_title ?? '').toUpperCase();
  if (title.includes('WORKSHOP')) return 'workshop';
  if (title.includes('COMMUNITY REDEVELOPMENT')) return 'cra';
  const dt = (transcriptData.meeting_date_time ?? '').toUpperCase();
  if (/5:0[01]\s*P|[6-9]:\d\d\s*P/.test(dt)) return 'evening';
  return 'regular';
}

/**
 * Match processed transcripts + video mappings to agenda meetings already in
 * the DB, populating transcript_source_id. For transcripts with no matching
 * agenda (historical or different ID space), inserts a stub meeting row so
 * they remain accessible.
 */
function matchTranscripts(db) {
  const updateTranscriptId = db.prepare(
    'UPDATE meetings SET transcript_source_id = ? WHERE id = ?'
  );
  const findMeeting = db.prepare(
    'SELECT id FROM meetings WHERE date = ? AND meeting_type = ? ORDER BY item_count DESC LIMIT 1'
  );
  // Stub rows use a synthetic ID outside the OnBase ID range (OnBase IDs ~2400-2900)
  const insertStub = db.prepare(`
    INSERT OR IGNORE INTO meetings (id, date, meeting_type, title, transcript_source_id, item_count)
    VALUES (?, ?, ?, ?, ?, 0)
  `);

  // Index video mappings by their transcript meeting ID
  const videoMappings = {};
  for (const f of glob.sync(path.join(TRANSCRIPT_DIR, 'video_mapping_*.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
      videoMappings[String(d.meeting_id)] = d;
    } catch { /* skip corrupt files */ }
  }

  const transcriptFiles = glob.sync(
    path.join(PROCESSED_DIR, 'processed_transcript_*.json')
  );

  let matched = 0;
  let stubbed = 0;
  let skipped = 0;

  for (const f of transcriptFiles) {
    const filename = path.basename(f);
    // Date and transcript ID are reliable in the filename
    const m = filename.match(/processed_transcript_(\d+)_(\d{4}-\d{2}-\d{2})\.json/);
    if (!m) { skipped++; continue; }
    const [, transcriptId, transcriptDate] = m;

    let transcriptData;
    try {
      transcriptData = JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch {
      console.warn(`  Skipping ${filename}: parse error`);
      skipped++;
      continue;
    }

    const videoMapping = videoMappings[transcriptId];
    const meetingType = inferMeetingType(transcriptData, videoMapping);

    const agendaMeeting = findMeeting.get(transcriptDate, meetingType);
    if (agendaMeeting) {
      updateTranscriptId.run(transcriptId, agendaMeeting.id);
      matched++;
    } else {
      // No matching agenda — insert stub so transcript data has a home
      const stubId = 1_000_000 + parseInt(transcriptId, 10);
      insertStub.run(
        stubId,
        transcriptDate,
        meetingType,
        buildTitle(meetingType, transcriptDate),
        transcriptId
      );
      stubbed++;
    }
  }

  console.log(
    `  Transcripts: ${matched} matched to agendas, ${stubbed} stub rows created, ${skipped} skipped`
  );
}

/**
 * Import transcript segments from processed transcript JSON files.
 * Each segment row is linked to the meeting via transcript_source_id.
 */
function importTranscriptSegments(db) {
  const findMeeting = db.prepare(
    'SELECT id FROM meetings WHERE transcript_source_id = ? LIMIT 1'
  );
  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (meeting_id, segment_index, timestamp, speaker, text) VALUES (?, ?, ?, ?, ?)'
  );

  const transcriptFiles = glob.sync(
    path.join(PROCESSED_DIR, 'processed_transcript_*.json')
  );

  let totalSegments = 0;
  let totalMeetings = 0;

  const doInsert = db.transaction(() => {
    for (const f of transcriptFiles) {
      const filename = path.basename(f);
      const m = filename.match(/processed_transcript_(\d+)_/);
      if (!m) continue;
      const transcriptId = m[1];

      const meeting = findMeeting.get(transcriptId);
      if (!meeting) continue;

      let data;
      try {
        data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      } catch {
        console.warn(`  Skipping segments for ${filename}: parse error`);
        continue;
      }

      const segments = data.segments || [];
      let idx = 0;
      for (const seg of segments) {
        insertSegment.run(
          meeting.id,
          idx++,
          seg.timestamp || null,
          seg.speaker || null,
          seg.text || '',
        );
      }
      totalSegments += segments.length;
      totalMeetings++;
    }
  });
  doInsert();

  console.log(
    `  Segments: ${totalSegments} inserted across ${totalMeetings} meetings`
  );
}

/**
 * Import videos and chapters from video_mapping_*.json files.
 * Videos and chapters are linked to meetings via transcript_source_id.
 */
function importVideos(db) {
  const findMeeting = db.prepare(
    'SELECT id FROM meetings WHERE transcript_source_id = ? LIMIT 1'
  );
  const insertVideo = db.prepare(
    'INSERT INTO videos (meeting_id, video_id, title, part, session, published_at, duration, offset_seconds, transcript_start_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertChapter = db.prepare(
    'INSERT INTO video_chapters (video_db_id, chapter_index, title, timestamp, seconds) VALUES (?, ?, ?, ?, ?)'
  );

  const mappingFiles = glob.sync(path.join(TRANSCRIPT_DIR, 'video_mapping_*.json'));

  let totalVideos = 0;
  let totalChapters = 0;

  const doInsert = db.transaction(() => {
    for (const f of mappingFiles) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      } catch {
        console.warn(`  Skipping ${path.basename(f)}: parse error`);
        continue;
      }

      // Skip files without meeting_id or videos array (e.g. bare video_mapping.json)
      if (!data.meeting_id || !Array.isArray(data.videos)) continue;

      const meeting = findMeeting.get(String(data.meeting_id));
      if (!meeting) continue;

      for (const v of data.videos) {
        const result = insertVideo.run(
          meeting.id,
          v.video_id,
          v.title || null,
          v.part || 1,
          v.session || null,
          v.published_at || null,
          v.duration || null,
          v.offset_seconds ?? 0,
          v.transcript_start_time || null,
        );
        const videoDbId = result.lastInsertRowid;
        totalVideos++;

        let chIdx = 0;
        for (const ch of v.chapters || []) {
          insertChapter.run(
            videoDbId,
            chIdx++,
            ch.title || null,
            ch.timestamp || null,
            ch.seconds ?? null,
          );
          totalChapters++;
        }
      }
    }
  });
  doInsert();

  console.log(`  Videos: ${totalVideos} inserted, ${totalChapters} chapters`);
}

function buildTitle(type, dateStr) {
  const label = TYPE_LABELS[type] || type;
  const d = new Date(dateStr + 'T12:00:00');
  const formatted = d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `${label} — ${formatted}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const yearFlag = args.indexOf('--year');
  const yearFilter = yearFlag !== -1 ? args[yearFlag + 1] : null;

  // Ensure output directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Find all meeting JSON files (skip _old variants)
  const pattern = path.join(DATA_DIR, 'meeting_*_*.json');
  const files = glob.sync(pattern).filter((f) => !f.includes('_old'));

  if (files.length === 0) {
    console.error('No meeting JSON files found in', DATA_DIR);
    process.exit(1);
  }

  // Open (or create) database
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Drop existing tables and recreate (reverse dependency order)
  db.exec('DROP TABLE IF EXISTS video_chapters');
  db.exec('DROP TABLE IF EXISTS videos');
  db.exec('DROP TABLE IF EXISTS transcript_segments');
  db.exec('DROP TABLE IF EXISTS documents');
  db.exec('DROP TABLE IF EXISTS agenda_items');
  db.exec('DROP TABLE IF EXISTS meetings');
  db.exec(SCHEMA);

  // Prepare insert statements
  const insertMeeting = db.prepare(`
    INSERT OR REPLACE INTO meetings (id, date, meeting_type, title, agenda_type, source_url, item_count)
    VALUES (@id, @date, @meeting_type, @title, @agenda_type, @source_url, @item_count)
  `);

  const insertItem = db.prepare(`
    INSERT INTO agenda_items
      (meeting_id, item_number, agenda_item_id, file_number, title, background,
       location, coordinates, dollar_amounts, fiscal_expenditures, fiscal_revenues, fiscal_net)
    VALUES
      (@meeting_id, @item_number, @agenda_item_id, @file_number, @title, @background,
       @location, @coordinates, @dollar_amounts, @fiscal_expenditures, @fiscal_revenues, @fiscal_net)
  `);

  const insertDoc = db.prepare(`
    INSERT INTO documents (agenda_item_id, title, source_url, mirrored_url, original_text)
    VALUES (@agenda_item_id, @title, @source_url, @mirrored_url, @original_text)
  `);

  // Stats
  let meetingCount = 0;
  let itemCount = 0;
  let docCount = 0;
  let skipped = 0;

  const importAll = db.transaction(() => {
    for (const filePath of files) {
      const filename = path.basename(filePath);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        console.warn(`  Skipping ${filename}: ${err.message}`);
        skipped++;
        continue;
      }

      const date = resolveDate(data, filename);
      if (!date) {
        console.warn(`  Skipping ${filename}: could not determine date`);
        skipped++;
        continue;
      }

      // Apply year filter if specified
      if (yearFilter && !date.startsWith(yearFilter)) {
        continue;
      }

      const meetingId = parseInt(data.meetingId, 10);
      if (isNaN(meetingId)) {
        console.warn(`  Skipping ${filename}: invalid meetingId`);
        skipped++;
        continue;
      }

      const items = data.agendaItems || [];
      const meetingType = inferTypeFromItems(items);

      insertMeeting.run({
        id: meetingId,
        date,
        meeting_type: meetingType,
        title: buildTitle(meetingType, date),
        agenda_type: data.agendaType || null,
        source_url: data.sourceUrl || null,
        item_count: items.length,
      });
      meetingCount++;

      for (const item of items) {
        const financials = item.financialTotals || {};

        const result = insertItem.run({
          meeting_id: meetingId,
          item_number: item.number || null,
          agenda_item_id: item.agendaItemId || null,
          file_number: item.fileNumber || null,
          title: item.title || null,
          background: item.background || null,
          location: item.location || null,
          coordinates: item.coordinates ? JSON.stringify(item.coordinates) : null,
          dollar_amounts: item.dollarAmounts?.length ? JSON.stringify(item.dollarAmounts) : null,
          fiscal_expenditures: financials.expenditures || 0,
          fiscal_revenues: financials.revenues || 0,
          fiscal_net: financials.net || 0,
        });
        itemCount++;

        const rowId = result.lastInsertRowid;

        for (const doc of item.supportingDocuments || []) {
          insertDoc.run({
            agenda_item_id: rowId,
            title: doc.title || doc.originalText || 'Document',
            source_url: doc.url || null,
            mirrored_url: doc.mirroredUrl || null,
            original_text: doc.originalText || null,
          });
          docCount++;
        }
      }
    }
  });

  importAll();

  // Deduplicate meetings: when multiple IDs share the same (date, meeting_type),
  // keep only the one with the most agenda items (FINAL > DRAFT).
  const dupes = db.prepare(`
    SELECT id, date, meeting_type, item_count FROM meetings
    WHERE (date, meeting_type) IN (
      SELECT date, meeting_type FROM meetings
      GROUP BY date, meeting_type HAVING COUNT(*) > 1
    )
    ORDER BY date, meeting_type, item_count DESC
  `).all();

  if (dupes.length > 0) {
    const seen = new Set();
    const toDelete = [];
    for (const row of dupes) {
      const key = `${row.date}|${row.meeting_type}`;
      if (seen.has(key)) {
        toDelete.push(row);
      } else {
        seen.add(key);
      }
    }
    if (toDelete.length > 0) {
      const delDocs = db.prepare('DELETE FROM documents WHERE agenda_item_id IN (SELECT id FROM agenda_items WHERE meeting_id = ?)');
      const delItems = db.prepare('DELETE FROM agenda_items WHERE meeting_id = ?');
      const delSegments = db.prepare('DELETE FROM transcript_segments WHERE meeting_id = ?');
      const delChapters = db.prepare('DELETE FROM video_chapters WHERE video_db_id IN (SELECT id FROM videos WHERE meeting_id = ?)');
      const delVideos = db.prepare('DELETE FROM videos WHERE meeting_id = ?');
      const delMeeting = db.prepare('DELETE FROM meetings WHERE id = ?');
      for (const row of toDelete) {
        delDocs.run(row.id);
        delItems.run(row.id);
        delSegments.run(row.id);
        delChapters.run(row.id);
        delVideos.run(row.id);
        delMeeting.run(row.id);
        meetingCount--;
        console.log(`  Dedup: removed meeting ${row.id} (${row.date} ${row.meeting_type}, ${row.item_count} items) — superseded`);
      }
    }
  }

  matchTranscripts(db);
  importTranscriptSegments(db);
  importVideos(db);
  db.close();

  console.log(`Database built: ${DB_PATH}`);
  console.log(`  Meetings:  ${meetingCount}`);
  console.log(`  Items:     ${itemCount}`);
  console.log(`  Documents: ${docCount}`);
  if (skipped > 0) console.log(`  Skipped:   ${skipped}`);
}

main();

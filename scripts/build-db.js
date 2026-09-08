#!/usr/bin/env node
/**
 * Build SQLite database from agenda JSON files.
 *
 * Usage:
 *   node scripts/build-db.js                       # Import all meetings
 *   node scripts/build-db.js --year 2026           # Only 2026 agendas, transcripts and videos
 *   node scripts/build-db.js --output /tmp/x.db    # Build somewhere else (scratch builds)
 *
 * Reads JSON from agenda-scraper/data/ and writes to data/meetings.db.
 * The build is atomic: it writes to <output>.building and renames over the
 * target only when every step succeeds, so a crash or a Ctrl-C never leaves
 * a half-populated database behind.
 *
 * Addenda: OnBase publishes an addendum as a second meeting on the same date
 * with the same type. Its items are folded into the parent meeting's
 * agenda_items with from_addendum = 1 (see foldAddenda); it never becomes a
 * meeting row of its own. Two distinct meetings on one day (e.g. two budget
 * workshops) are both kept.
 *
 * Videos: a video_mapping_<id>.json whose `verification.status` is "fail"
 * (written by scripts/record-offset-verification.py from the archive
 * pipeline's Step 3b) is skipped, so a known-bad offset never reaches the site.
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
  clerk_title TEXT,
  agenda_type TEXT,
  source_url TEXT,
  item_count INTEGER DEFAULT 0,
  transcript_source_id TEXT,
  addendum_ids TEXT
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
  staff_report TEXT,
  from_addendum INTEGER NOT NULL DEFAULT 0,
  addendum_meeting_id INTEGER,
  addendum_section TEXT,
  continued_to_date TEXT
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
 * Map video_mapping.meeting_type values and OnBase meetingType display names
 * → meetings.meeting_type slugs. OnBase uses names like "Council Evening" /
 * "CRA Regular"; the video mapping uses "City Council" / "Evening"; the DB
 * uses slug form.
 */
const VIDEO_MEETING_TYPE_MAP = {
  'city council': 'regular',
  'workshop': 'workshop',
  'evening': 'evening',
  'cra': 'cra',
  'special': 'special',
  'council regular': 'regular',
  'council evening': 'evening',
  'council workshop': 'workshop',
  'council special': 'special',
  'cra regular': 'cra',
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
 * Manual transcript → agenda meeting pairings for dates where the date-only
 * fallback in matchTranscripts is ambiguous (two agenda meetings, two
 * transcripts, nothing on the agenda side to tell them apart). Keys are
 * transcript meeting IDs as strings, values are OnBase meeting IDs.
 * The build logs "ambiguous" for any new case that needs an entry here.
 */
const TRANSCRIPT_MEETING_OVERRIDES = {
  '2624': 2629, // 2025-08-11 9:00 AM budget workshop (recommended FY26 budget, 4 items)
  '2623': 2670, // 2025-08-11 5:01 PM budget workshop (stormwater budget, 1 item)
};

/**
 * Manual type overrides for agenda meetings where automatic inference fails
 * or OnBase classification is incorrect (e.g. dual meetings).
 * Keys are OnBase meeting IDs as numbers.
 */
const MEETING_TYPE_OVERRIDES = {
  2889: 'cra', // 2026-05-21 Special CRA Meeting — OnBase lists as 'special', but it was a CRA meeting
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
function matchTranscripts(db, yearFilter = null) {
  const updateTranscriptId = db.prepare(
    'UPDATE meetings SET transcript_source_id = ? WHERE id = ?'
  );
  const updateType = db.prepare(
    'UPDATE meetings SET meeting_type = ?, title = ? WHERE id = ?'
  );
  // Only unclaimed meetings: two transcripts inferred as the same type on the
  // same date (4/9/26: the near-empty CRA pkey 2669 and the real evening pkey
  // 2670 both said "Evening") used to overwrite each other in glob order.
  const findMeeting = db.prepare(
    'SELECT id FROM meetings WHERE date = ? AND meeting_type = ? AND transcript_source_id IS NULL ORDER BY item_count DESC LIMIT 1'
  );
  // Fallback: agenda meetings on a date that no transcript claimed in pass 1.
  // Type inference disagrees between the two pipelines for special-call /
  // budget meetings (e.g. agenda says "evening", video mapping says
  // "Special"), so an unambiguous same-date leftover is the same meeting.
  const findUnclaimed = db.prepare(
    'SELECT id, meeting_type FROM meetings WHERE date = ? AND transcript_source_id IS NULL AND id < 1000000'
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

  // Pass 1: exact (date, meeting_type) matches. Leftovers go to pass 2.
  const unmatchedTranscripts = [];

  for (const f of transcriptFiles) {
    const filename = path.basename(f);
    // Date and transcript ID are reliable in the filename
    const m = filename.match(/processed_transcript_(\d+)_(\d{4}-\d{2}-\d{2})\.json/);
    if (!m) { skipped++; continue; }
    const [, transcriptId, transcriptDate] = m;
    if (yearFilter && !transcriptDate.startsWith(yearFilter)) continue;

    let transcriptData;
    try {
      transcriptData = JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch {
      console.warn(`  Skipping ${filename}: parse error`);
      skipped++;
      continue;
    }

    // An empty transcript (source page had no timestamped speaker lines)
    // must never claim a meeting — it would shadow the real one and publish
    // a blank transcript page.
    if (!Array.isArray(transcriptData.segments) || transcriptData.segments.length === 0) {
      console.warn(`  Skipping ${filename}: 0 segments`);
      skipped++;
      continue;
    }

    const videoMapping = videoMappings[transcriptId];
    const meetingType = inferMeetingType(transcriptData, videoMapping);

    if (TRANSCRIPT_MEETING_OVERRIDES[transcriptId]) {
      const overrideId = TRANSCRIPT_MEETING_OVERRIDES[transcriptId];
      updateTranscriptId.run(transcriptId, overrideId);
      // Same type refinement as the date-only fallback below: the transcript
      // side knows a 'regular'-labelled agenda was really a workshop etc.
      const agenda = db.prepare('SELECT meeting_type FROM meetings WHERE id = ?').get(overrideId);
      if (agenda && agenda.meeting_type === 'regular' && meetingType !== 'regular') {
        updateType.run(meetingType, buildTitle(meetingType, transcriptDate), overrideId);
      }
      matched++;
      continue;
    }

    const agendaMeeting = findMeeting.get(transcriptDate, meetingType);
    if (agendaMeeting) {
      updateTranscriptId.run(transcriptId, agendaMeeting.id);
      matched++;
    } else {
      unmatchedTranscripts.push({ transcriptId, transcriptDate, meetingType });
    }
  }

  // Pass 2: date-only fallback. If exactly one agenda meeting on the date is
  // still unclaimed, it's the same meeting under a different type label.
  // Ambiguous dates (0 or 2+ unclaimed agendas) fall through to a stub row.
  for (const { transcriptId, transcriptDate, meetingType } of unmatchedTranscripts) {
    const candidates = findUnclaimed.all(transcriptDate);
    if (candidates.length === 1) {
      const agenda = candidates[0];
      updateTranscriptId.run(transcriptId, agenda.id);
      // The agenda side defaults to 'regular' when nothing on the agenda
      // signals a type; the transcript side (video title, time of day) is
      // better informed there. Non-regular agenda types are kept.
      if (agenda.meeting_type === 'regular' && meetingType !== 'regular') {
        updateType.run(meetingType, buildTitle(meetingType, transcriptDate), agenda.id);
      }
      console.log(
        `  Date-matched transcript ${transcriptId} → meeting ${agenda.id} ` +
        `(transcript type '${meetingType}', agenda type '${agenda.meeting_type}')`
      );
      matched++;
    } else {
      if (candidates.length > 1) {
        console.warn(
          `  Transcript ${transcriptId} (${transcriptDate}, '${meetingType}') is ambiguous: ` +
          `${candidates.length} unclaimed agenda meetings on that date (${candidates.map((c) => c.id).join(', ')}). ` +
          `Add it to TRANSCRIPT_MEETING_OVERRIDES; stub row created for now.`
        );
      }
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
  let failedVerification = 0;

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

      // Step 3b of archive-meeting.sh records its verdict in the mapping.
      // A failed verdict means the offset is known to be wrong: publishing
      // it would put bad ?t= links on the page, so the meeting gets no videos
      // until the mapping is re-verified.
      const verdict = data.verification && data.verification.status;
      if (verdict === 'fail') {
        console.warn(
          `  Skipping videos for transcript ${data.meeting_id} (meeting ${meeting.id}): ` +
          `offset verification failed${data.verification.checked_at ? ` on ${data.verification.checked_at}` : ''}`
        );
        failedVerification++;
        continue;
      }

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

  console.log(
    `  Videos: ${totalVideos} inserted, ${totalChapters} chapters` +
    (failedVerification ? `, ${failedVerification} mapping(s) skipped (failed verification)` : '')
  );
}

/**
 * Display title. The weekly types keep the fixed labels; 'special' is too
 * generic on its own (a CRA special call and a council special call both
 * map to it), so it uses the clerk's name when the scraper captured one.
 */
function buildTitle(type, dateStr, clerkTitle = null) {
  const label = (type === 'special' && clerkTitle) ? clerkTitle : (TYPE_LABELS[type] || type);
  const d = new Date(dateStr + 'T12:00:00');
  const formatted = d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `${label} — ${formatted}`;
}

// ---------------------------------------------------------------------------
// Meeting import
// ---------------------------------------------------------------------------

/**
 * Addenda scraped before the scraper started setting `isAddendum` (older
 * files, no meetingName either). Identified by hand from the data: each is a
 * small DRAFT file on the date of a large FINAL meeting whose items it amends.
 */
const ADDENDUM_OVERRIDES = new Set([2719, 2781, 2787]);

function isAddendum(data, meetingId) {
  return data.isAddendum === true ||
    /addendum/i.test(data.meetingName || '') ||
    ADDENDUM_OVERRIDES.has(meetingId);
}

/** meeting_type slug for an agenda JSON: item prefixes first, OnBase label second, overrides last. */
function resolveMeetingType(data, items, meetingId) {
  let meetingType = inferTypeFromItems(items);
  // inferTypeFromItems defaults to 'regular' when item prefixes don't
  // indicate a specialised type (CRA, evening). Fall back to the JSON's
  // own meetingType for meetings OnBase explicitly classifies as non-regular
  // (e.g. specially-called workshops where item prefixes are generic).
  if (meetingType === 'regular' && data.meetingType) {
    const mapped = VIDEO_MEETING_TYPE_MAP[data.meetingType.toLowerCase()];
    if (mapped && mapped !== 'regular') meetingType = mapped;
  }
  if (MEETING_TYPE_OVERRIDES[meetingId]) meetingType = MEETING_TYPE_OVERRIDES[meetingId];
  return meetingType;
}

/**
 * Parse every meeting JSON into a record, splitting addenda from meetings.
 * Nothing is written here, so a parse problem is reported before the DB is
 * touched.
 */
function loadMeetingFiles(files, yearFilter) {
  const meetings = [];
  const addenda = [];
  let skipped = 0;

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
    if (yearFilter && !date.startsWith(yearFilter)) continue;

    const meetingId = parseInt(data.meetingId, 10);
    if (isNaN(meetingId)) {
      console.warn(`  Skipping ${filename}: invalid meetingId`);
      skipped++;
      continue;
    }

    const items = data.agendaItems || [];
    const record = {
      meetingId,
      date,
      meetingType: resolveMeetingType(data, items, meetingId),
      items,
      data,
    };
    (isAddendum(data, meetingId) ? addenda : meetings).push(record);
  }

  return { meetings, addenda, skipped };
}

/**
 * Pick the meeting an addendum amends: the largest same-date meeting of the
 * same type, or the only same-date meeting when types disagree (an evening
 * addendum with no file numbers infers as 'regular'). Null when ambiguous.
 */
function findParent(addendum, meetingsOnDate) {
  const sameType = meetingsOnDate.filter((m) => m.meetingType === addendum.meetingType);
  const pool = sameType.length > 0 ? sameType : (meetingsOnDate.length === 1 ? meetingsOnDate : []);
  if (pool.length === 0) return null;
  return pool.reduce((best, m) => (m.items.length > best.items.length ? m : best));
}

function importMeetings(db, meetings, addenda) {
  const insertMeeting = db.prepare(`
    INSERT INTO meetings (id, date, meeting_type, title, clerk_title, agenda_type, source_url, item_count, addendum_ids)
    VALUES (@id, @date, @meeting_type, @title, @clerk_title, @agenda_type, @source_url, @item_count, @addendum_ids)
  `);
  const insertItem = db.prepare(`
    INSERT INTO agenda_items
      (meeting_id, item_number, agenda_item_id, file_number, title, background,
       location, coordinates, staff_report,
       from_addendum, addendum_meeting_id, addendum_section, continued_to_date)
    VALUES
      (@meeting_id, @item_number, @agenda_item_id, @file_number, @title, @background,
       @location, @coordinates, @staff_report,
       @from_addendum, @addendum_meeting_id, @addendum_section, @continued_to_date)
  `);
  const insertDoc = db.prepare(`
    INSERT INTO documents (agenda_item_id, title, source_url, mirrored_url, original_text)
    VALUES (@agenda_item_id, @title, @source_url, @mirrored_url, @original_text)
  `);
  const attachAddendum = db.prepare(`
    UPDATE meetings SET item_count = item_count + @added, addendum_ids = @addendum_ids WHERE id = @id
  `);

  const stats = { meetings: 0, items: 0, documents: 0, addendaFolded: 0, addendaStandalone: 0 };

  function insertItems(meetingId, items, addendum = null) {
    for (const item of items) {
      const result = insertItem.run({
        meeting_id: meetingId,
        item_number: item.number || null,
        agenda_item_id: item.agendaItemId || null,
        file_number: item.fileNumber || null,
        title: item.title || null,
        background: item.background || null,
        location: item.location || null,
        coordinates: item.coordinates ? JSON.stringify(item.coordinates) : null,
        staff_report: item.staffReport ? JSON.stringify(item.staffReport) : null,
        from_addendum: addendum ? 1 : 0,
        addendum_meeting_id: addendum ? addendum.meetingId : null,
        addendum_section: addendum ? (item.addendumSection || 'otherChanges') : null,
        continued_to_date: item.continuedToDate || null,
      });
      stats.items++;
      for (const doc of item.supportingDocuments || []) {
        insertDoc.run({
          agenda_item_id: result.lastInsertRowid,
          title: doc.title || doc.originalText || 'Document',
          source_url: doc.url || null,
          mirrored_url: doc.mirroredUrl || null,
          original_text: doc.originalText || null,
        });
        stats.documents++;
      }
    }
  }

  function insertMeetingRecord(rec, { agendaType = rec.data.agendaType || null } = {}) {
    insertMeeting.run({
      id: rec.meetingId,
      date: rec.date,
      meeting_type: rec.meetingType,
      title: buildTitle(rec.meetingType, rec.date, rec.data.meetingName),
      clerk_title: rec.data.meetingName || null,
      agenda_type: agendaType,
      source_url: rec.data.sourceUrl || null,
      item_count: rec.items.length,
      addendum_ids: null,
    });
    stats.meetings++;
    insertItems(rec.meetingId, rec.items);
  }

  const importAll = db.transaction(() => {
    const byDate = {};
    for (const rec of meetings) {
      insertMeetingRecord(rec);
      (byDate[rec.date] ||= []).push(rec);
    }

    const foldedInto = {};
    for (const a of addenda.sort((x, y) => x.meetingId - y.meetingId)) {
      const parent = findParent(a, byDate[a.date] || []);
      if (!parent) {
        console.warn(
          `  Addendum ${a.meetingId} (${a.date} ${a.meetingType}, ${a.items.length} items): ` +
          `no parent meeting on that date — imported as its own meeting`
        );
        insertMeetingRecord(a, { agendaType: 'ADDENDUM' });
        stats.addendaStandalone++;
        continue;
      }
      insertItems(parent.meetingId, a.items, a);
      (foldedInto[parent.meetingId] ||= []).push(a.meetingId);
      attachAddendum.run({
        id: parent.meetingId,
        added: a.items.length,
        addendum_ids: JSON.stringify(foldedInto[parent.meetingId]),
      });
      stats.addendaFolded++;
      console.log(`  Addendum ${a.meetingId} → meeting ${parent.meetingId} (${a.date}, ${a.items.length} items)`);
    }
  });
  importAll();

  // Distinct meetings that share a date and type are legitimate (two budget
  // workshops on 2025-08-11). They used to be deduped to one; now they are
  // only reported, so a genuine re-scrape under a new OnBase id is visible.
  const collisions = db.prepare(`
    SELECT date, meeting_type, GROUP_CONCAT(id) AS ids, COUNT(*) AS n
    FROM meetings GROUP BY date, meeting_type HAVING n > 1 ORDER BY date
  `).all();
  for (const c of collisions) {
    console.log(`  Note: ${c.n} ${c.meeting_type} meetings on ${c.date} (${c.ids}) — kept all`);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/build-db.js [--year YYYY] [--output PATH]

  --year YYYY     Import only agendas, transcripts and videos dated in YYYY
  --output PATH   Write the database to PATH instead of data/meetings.db`;

function parseArgs(argv) {
  const opts = { year: null, output: DB_PATH };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--year') {
      opts.year = argv[++i];
      if (!/^\d{4}$/.test(opts.year || '')) {
        console.error('--year expects a four-digit year');
        process.exit(1);
      }
    } else if (arg === '--output') {
      if (!argv[i + 1]) {
        console.error('--output expects a path');
        process.exit(1);
      }
      opts.output = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}\n${USAGE}`);
      process.exit(1);
    }
  }
  return opts;
}

function removeIfExists(p) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function main() {
  const { year: yearFilter, output: outPath } = parseArgs(process.argv.slice(2));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Find all meeting JSON files (skip _old variants)
  const pattern = path.join(DATA_DIR, 'meeting_*_*.json');
  const files = glob.sync(pattern).filter((f) => !f.includes('_old'));
  if (files.length === 0) {
    console.error('No meeting JSON files found in', DATA_DIR);
    process.exit(1);
  }

  // Build into a scratch file next to the target; swap in only on success.
  const tmpPath = `${outPath}.building`;
  for (const side of ['', '-journal', '-wal', '-shm']) removeIfExists(tmpPath + side);

  const db = new Database(tmpPath);
  // The site opens the file read-only and asks for WAL; that only works when
  // the file was created in WAL mode, so set it here and checkpoint on close.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  let stats;
  try {
    const { meetings, addenda, skipped } = loadMeetingFiles(files, yearFilter);
    stats = importMeetings(db, meetings, addenda);
    stats.skipped = skipped;
    matchTranscripts(db, yearFilter);
    importTranscriptSegments(db);
    importVideos(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    for (const side of ['', '-journal', '-wal', '-shm']) removeIfExists(tmpPath + side);
    console.error(`Build failed, ${path.basename(outPath)} left untouched: ${err.message}`);
    process.exit(1);
  }

  // The previous database may have been opened in WAL mode by the site build;
  // its sidecar files would be read against the new file, so clear them.
  removeIfExists(`${outPath}-wal`);
  removeIfExists(`${outPath}-shm`);
  fs.renameSync(tmpPath, outPath);
  removeIfExists(`${tmpPath}-wal`);
  removeIfExists(`${tmpPath}-shm`);

  console.log(`Database built: ${outPath}`);
  console.log(`  Meetings:  ${stats.meetings}`);
  console.log(`  Items:     ${stats.items}`);
  console.log(`  Documents: ${stats.documents}`);
  console.log(`  Addenda:   ${stats.addendaFolded} folded into parent meetings` +
    (stats.addendaStandalone ? `, ${stats.addendaStandalone} standalone` : ''));
  if (stats.skipped > 0) console.log(`  Skipped:   ${stats.skipped}`);
}

main();

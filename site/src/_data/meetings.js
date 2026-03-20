const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'meetings.db');

module.exports = function () {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');

  // ------------------------------------------------------------------
  // All meetings with content (agenda items or transcript), reverse chrono
  // has_transcript and has_video are 0/1 integers from SQLite
  // ------------------------------------------------------------------
  const all = db.prepare(`
    SELECT
      m.*,
      CASE WHEN m.transcript_source_id IS NOT NULL THEN 1 ELSE 0 END AS has_transcript,
      CASE WHEN EXISTS (SELECT 1 FROM videos v WHERE v.meeting_id = m.id) THEN 1 ELSE 0 END AS has_video
    FROM meetings m
    WHERE m.item_count > 0 OR m.transcript_source_id IS NOT NULL
    ORDER BY m.date DESC, m.meeting_type
  `).all();

  // ------------------------------------------------------------------
  // First video_id per meeting (for YouTube thumbnail on homepage)
  // ------------------------------------------------------------------
  const stmtFirstVideo = db.prepare(`
    SELECT video_id FROM videos WHERE meeting_id = ? ORDER BY part LIMIT 1
  `);
  for (const m of all) {
    const row = stmtFirstVideo.get(m.id);
    m.video_id = row ? row.video_id : null;
  }

  // ------------------------------------------------------------------
  // Group by date for homepage
  // ------------------------------------------------------------------
  const byDate = {};
  const dates = [];
  for (const m of all) {
    if (!byDate[m.date]) {
      byDate[m.date] = [];
      dates.push(m.date);
    }
    byDate[m.date].push(m);
  }

  // ------------------------------------------------------------------
  // Public meetings: 2026+ only, for the homepage listing
  // (older meetings still exist as detail pages, just hidden from index)
  // ------------------------------------------------------------------
  const PUBLIC_CUTOFF = '2026-01-01';
  const publicDates = dates.filter((d) => d >= PUBLIC_CUTOFF);
  const publicByDate = {};
  for (const d of publicDates) {
    publicByDate[d] = byDate[d];
  }

  // ------------------------------------------------------------------
  // Prepared statements for detail queries
  // ------------------------------------------------------------------
  const stmtItems = db.prepare(`
    SELECT * FROM agenda_items WHERE meeting_id = ? ORDER BY item_number
  `);
  const stmtDocs = db.prepare(`
    SELECT * FROM documents WHERE agenda_item_id = ? ORDER BY id
  `);
  const stmtSegments = db.prepare(`
    SELECT segment_index, timestamp, speaker, text
    FROM transcript_segments
    WHERE meeting_id = ?
    ORDER BY segment_index
  `);
  const stmtVideos = db.prepare(`
    SELECT id AS db_id, video_id, title, part, session,
           published_at, duration, offset_seconds, transcript_start_time
    FROM videos
    WHERE meeting_id = ?
    ORDER BY part
  `);
  const stmtChapters = db.prepare(`
    SELECT chapter_index, title, timestamp, seconds
    FROM video_chapters
    WHERE video_db_id = ?
    ORDER BY chapter_index
  `);

  // ------------------------------------------------------------------
  // Full detail per meeting (items + documents + segments + videos)
  // ------------------------------------------------------------------
  const details = {};
  for (const m of all) {
    const items = stmtItems.all(m.id);
    for (const item of items) {
      item.documents = stmtDocs.all(item.id);
    }

    const transcript_segments = m.has_transcript
      ? stmtSegments.all(m.id)
      : [];

    const videos = m.has_video
      ? stmtVideos.all(m.id).map((v) => {
          const { db_id, ...rest } = v;
          return { ...rest, chapters: stmtChapters.all(db_id) };
        })
      : [];

    // Compute transcript baseline: first segment's wall-clock timestamp
    const transcript_baseline = transcript_segments.length > 0
      ? (transcript_segments[0].timestamp || null)
      : null;

    details[m.id] = { ...m, items, transcript_segments, videos, transcript_baseline };
  }

  db.close();

  return { all, byDate, dates, publicDates, publicByDate, details };
};


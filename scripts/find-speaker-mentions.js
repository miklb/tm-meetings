#!/usr/bin/env node
/**
 * find-speaker-mentions.js
 *
 * Scan processed transcript JSON files for segments spoken by a given
 * speaker matching a given regex, and emit a Markdown report with links
 * to the meeting archive page and the corresponding YouTube timestamp.
 *
 * Video-seek math mirrors site/eleventy.config.js (videoSeekData /
 * youtubeUrl filters, ~lines 74-129):
 *   - segSec = seconds-of-day parsed from the segment's "H:MM:SSAM" timestamp
 *   - meetingBaseline = the transcript's first segment timestamp (seconds-of-day)
 *   - for each candidate video: baselineSec = video.transcript_start_time
 *     (parsed) if set, else meetingBaseline
 *   - pick the video with the largest baselineSec that is <= segSec
 *     (falling back to the first video if none qualify)
 *   - videoSec = max(0, offset_seconds + (segSec - baselineSec))
 *
 * Usage:
 *   node scripts/find-speaker-mentions.js \
 *     --speaker "Bill Carlson" \
 *     [--pattern "\\bRays\\b|public subsid\\w*"] \
 *     [--domain meetings.tampamonitor.com] \
 *     [--out docs/plans/carlson-rays-subsidies.md]
 *
 * With no --pattern, defaults to the "the Rays" / "public subsidy" search
 * this script was built for (with an x-ray/X-Ray exclusion on the Rays
 * side, per \bRays\b matching "rays" in "x-rays" across the hyphen).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'data', 'meetings.db');
const PROCESSED_DIR = path.join(
  REPO_ROOT,
  'transcript-cleaner',
  'processor',
  'data',
  'processed'
);
const MAPPING_DIR = path.join(
  REPO_ROOT,
  'transcript-cleaner',
  'processor',
  'data'
);

// ---------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------
function parseArgs(argv) {
  const args = { speaker: 'Bill Carlson', pattern: null, domain: 'meetings.tampamonitor.com', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--speaker') args.speaker = argv[++i];
    else if (a === '--pattern') args.pattern = argv[++i];
    else if (a === '--domain') args.domain = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------
// Match rules
// ---------------------------------------------------------------------
// Each rule: { label, test(text) -> array of {index, length, matched} }
let matchRules;
if (args.pattern) {
  const re = new RegExp(args.pattern, 'gi');
  matchRules = [
    {
      label: 'custom pattern',
      find(text) {
        const hits = [];
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          hits.push({ index: m.index, length: m[0].length, matched: m[0] });
          if (m[0].length === 0) re.lastIndex++;
        }
        return hits;
      },
    },
  ];
} else {
  matchRules = [
    {
      label: 'the Rays',
      find(text) {
        const re = /\bRays\b/gi;
        const hits = [];
        let m;
        while ((m = re.exec(text)) !== null) {
          const prefix = text.slice(Math.max(0, m.index - 2), m.index).toLowerCase();
          if (prefix === 'x-') continue; // exclude "x-rays"
          hits.push({ index: m.index, length: m[0].length, matched: m[0] });
        }
        return hits;
      },
    },
    {
      label: 'public subsid*',
      find(text) {
        const re = /\bpublic subsid\w*/gi;
        const hits = [];
        let m;
        while ((m = re.exec(text)) !== null) {
          hits.push({ index: m.index, length: m[0].length, matched: m[0] });
        }
        return hits;
      },
    },
  ];
}

function findAllHits(text) {
  const hits = [];
  for (const rule of matchRules) {
    for (const h of rule.find(text)) hits.push({ ...h, rule: rule.label });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

function boldMatches(text, hits) {
  if (!hits.length) return text;
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    if (h.index < cursor) continue; // overlapping match, skip
    out += text.slice(cursor, h.index);
    out += `**${text.slice(h.index, h.index + h.length)}**`;
    cursor = h.index + h.length;
  }
  out += text.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------
// Timestamp parsing (mirrors site/eleventy.config.js parseTimestampToSec)
// ---------------------------------------------------------------------
function parseTimestampToSec(ts) {
  if (!ts) return null;
  const m = String(ts).match(/(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let [, h, min, sec, meridiem] = m;
  h = parseInt(h, 10);
  min = parseInt(min, 10);
  sec = parseInt(sec, 10);
  if (meridiem.toUpperCase() === 'PM' && h !== 12) h += 12;
  if (meridiem.toUpperCase() === 'AM' && h === 12) h = 0;
  return h * 3600 + min * 60 + sec;
}

function resolveBaselineSec(video, meetingBaselineSec) {
  const tst = parseTimestampToSec(video.transcript_start_time);
  if (tst !== null) return tst;
  if (meetingBaselineSec !== undefined && meetingBaselineSec !== null) {
    return meetingBaselineSec;
  }
  return 0;
}

function resolveYoutubeUrl(segTimestamp, videos, meetingBaselineSec) {
  if (!videos || !videos.length || !segTimestamp) return null;
  const segSec = parseTimestampToSec(segTimestamp);
  if (segSec === null) return null;

  let bestVideo = null;
  let bestStartSec = -Infinity;
  for (const v of videos) {
    const startSec = resolveBaselineSec(v, meetingBaselineSec);
    if (startSec <= segSec && startSec > bestStartSec) {
      bestStartSec = startSec;
      bestVideo = v;
    }
  }
  if (!bestVideo) bestVideo = videos[0];
  if (!bestVideo) return null;

  const startSec = resolveBaselineSec(bestVideo, meetingBaselineSec);
  const videoSec = Math.max(0, bestVideo.offset_seconds + (segSec - startSec));
  return { url: `https://youtu.be/${bestVideo.video_id}?t=${Math.round(videoSec)}`, videoSec: Math.round(videoSec) };
}

// ---------------------------------------------------------------------
// DB lookups (via sqlite3 CLI, no inline runtime code)
// ---------------------------------------------------------------------
function sqliteJson(query) {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, query], { encoding: 'utf8' });
  const trimmed = out.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

const meetings = sqliteJson(`
  SELECT id, date, meeting_type, title, transcript_source_id
  FROM meetings
  WHERE transcript_source_id IS NOT NULL
  ORDER BY date ASC
`);

const videoRows = sqliteJson(`
  SELECT meeting_id, video_id, part, offset_seconds, transcript_start_time
  FROM videos
  ORDER BY meeting_id, part
`);

const videosByMeetingId = {};
for (const v of videoRows) {
  if (!videosByMeetingId[v.meeting_id]) videosByMeetingId[v.meeting_id] = [];
  videosByMeetingId[v.meeting_id].push(v);
}

// ---------------------------------------------------------------------
// Processed transcript + fallback video_mapping lookups
// ---------------------------------------------------------------------
const processedFiles = fs.readdirSync(PROCESSED_DIR);

function findProcessedFile(tid) {
  const prefix = `processed_transcript_${tid}_`;
  return processedFiles.find((f) => f.startsWith(prefix)) || null;
}

function loadFallbackMapping(tid) {
  const p = path.join(MAPPING_DIR, `video_mapping_${tid}.json`);
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!data.videos || !data.videos.length) return null;
  return data.videos.map((v) => ({
    video_id: v.video_id,
    part: v.part,
    offset_seconds: v.offset_seconds,
    transcript_start_time: v.transcript_start_time || null,
  }));
}

// ---------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------
const speakerLower = args.speaker.trim().toLowerCase();
const results = []; // { meeting, hits: [...] }
const noVideoTranscripts = [];
const missingProcessedFiles = [];

for (const meeting of meetings) {
  const tid = meeting.transcript_source_id;
  const fname = findProcessedFile(tid);
  if (!fname) {
    missingProcessedFiles.push({ meeting, tid });
    continue;
  }
  const transcriptPath = path.join(PROCESSED_DIR, fname);
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const segments = transcript.segments || [];
  if (!segments.length) continue;

  const meetingBaselineSec = parseTimestampToSec(segments[0].timestamp);

  let videos = videosByMeetingId[meeting.id] || null;
  let videoSource = 'db';
  if (!videos || !videos.length) {
    videos = loadFallbackMapping(tid);
    videoSource = 'fallback-json';
  }
  if (!videos || !videos.length) {
    videos = [];
    videoSource = 'none';
  }

  const meetingHits = [];
  for (const seg of segments) {
    if (!seg.speaker || seg.speaker.trim().toLowerCase() !== speakerLower) continue;
    const hits = findAllHits(seg.text || '');
    if (!hits.length) continue;

    const yt = resolveYoutubeUrl(seg.timestamp, videos, meetingBaselineSec);
    meetingHits.push({
      timestamp: seg.timestamp,
      quote: boldMatches(seg.text, hits),
      rules: [...new Set(hits.map((h) => h.rule))],
      youtube: yt,
    });
  }

  if (meetingHits.length) {
    if (videoSource === 'none') noVideoTranscripts.push(meeting);
    results.push({ meeting, hits: meetingHits, videoSource });
  }
}

// ---------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------
function fmtMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

const lines = [];
lines.push(`# ${args.speaker} — "the Rays" / public subsidy mentions`);
lines.push('');
lines.push(
  `Method: scanned processed transcripts (transcript-cleaner/processor/data/processed/) for segments spoken by **${args.speaker}** matching ` +
    (args.pattern
      ? `custom pattern \`${args.pattern}\``
      : '`\\bRays\\b` (excluding "x-rays") or `\\bpublic subsid\\w*\\b`') +
    `. Video timestamps computed with the same baseline/offset logic as site/eleventy.config.js \`videoSeekData\`/\`youtubeUrl\` filters. Domain used for archive links: \`${args.domain}\`.`
);
lines.push('');

let totalHits = 0;
for (const { meeting, hits, videoSource } of results) {
  totalHits += hits.length;
  lines.push(
    `## ${meeting.date} — ${meeting.meeting_type} — ${meeting.title || '(untitled)'}`
  );
  lines.push('');
  lines.push(`Archive: https://${args.domain}/meetings/${meeting.id}/`);
  if (videoSource === 'fallback-json') {
    lines.push('');
    lines.push(
      '_Note: this transcript has no `videos` row in data/meetings.db; timestamps below use the video_mapping JSON fallback._'
    );
  }
  lines.push('');
  for (const h of hits) {
    const label = h.rules.join(', ');
    if (h.youtube) {
      lines.push(
        `- **${h.timestamp}** — [video ▶ ${fmtMMSS(h.youtube.videoSec)}](${h.youtube.url}) _(${label})_ — "${h.quote}"`
      );
    } else {
      lines.push(`- **${h.timestamp}** — no video _(${label})_ — "${h.quote}"`);
    }
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push(`**Total hits: ${totalHits}** across ${results.length} meeting(s).`);
lines.push('');
lines.push('Hits per meeting:');
for (const { meeting, hits } of results) {
  lines.push(`- ${meeting.date} (meeting ${meeting.id}): ${hits.length}`);
}
if (noVideoTranscripts.length) {
  lines.push('');
  lines.push('Transcripts with hits but no video available:');
  for (const m of noVideoTranscripts) {
    lines.push(`- ${m.date} (meeting ${m.id}, transcript ${m.transcript_source_id})`);
  }
}
if (missingProcessedFiles.length) {
  lines.push('');
  lines.push('Meetings with a transcript_source_id but no processed JSON file found (skipped):');
  for (const { meeting, tid } of missingProcessedFiles) {
    lines.push(`- ${meeting.date} (meeting ${meeting.id}, transcript_source_id ${tid})`);
  }
}

const outPath = args.out
  ? path.resolve(REPO_ROOT, args.out)
  : path.join(REPO_ROOT, 'docs', 'plans', 'carlson-rays-subsidies.md');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

console.log(`Wrote ${outPath}`);
console.log(`Total hits: ${totalHits} across ${results.length} meeting(s)`);
for (const { meeting, hits } of results) {
  console.log(`  ${meeting.date} (meeting ${meeting.id}): ${hits.length}`);
}
if (noVideoTranscripts.length) {
  console.log('Transcripts with hits but no video:', noVideoTranscripts.map((m) => m.date).join(', '));
}
if (missingProcessedFiles.length) {
  console.log(
    'Meetings with transcript_source_id but no processed file:',
    missingProcessedFiles.map(({ meeting }) => meeting.date).join(', ')
  );
}

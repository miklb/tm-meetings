// Transcript-to-video seek math shared by the Eleventy filters.
//
// Transcript timestamps are wall-clock ("5:06:25PM"); video positions are
// seconds into a YouTube video. A video's offset_seconds says where its
// baseline transcript timestamp lands in the video, so a segment's position is
//   offset_seconds + (segment wall-clock − baseline wall-clock).
// Evening sessions can run past midnight (meeting 2652 ends at 3:04 AM), so
// the wall-clock difference must wrap: a segment that reads earlier than its
// baseline by more than half a day happened the next morning, not before the
// meeting started.

export const SECONDS_PER_DAY = 86400;
export const WRAP_THRESHOLD = SECONDS_PER_DAY / 2;

/**
 * Parse a transcript wall-clock timestamp like "9:15:50AM" or "01:02:10 PM"
 * into seconds since midnight. Returns null when the string does not parse.
 */
export function parseTimestampToSec(ts) {
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

/**
 * Seconds elapsed from `baselineSec` to `sec`, both seconds-since-midnight,
 * wrapping across midnight. Slightly negative values (clerk timestamps a few
 * seconds before the baseline) stay negative; the caller clamps.
 */
export function secondsSince(baselineSec, sec) {
  let elapsed = sec - baselineSec;
  if (elapsed < -WRAP_THRESHOLD) elapsed += SECONDS_PER_DAY;
  return elapsed;
}

/**
 * Baseline for a video: its transcript_start_time if present, otherwise the
 * meeting baseline (a timestamp string or seconds), otherwise 0.
 */
export function resolveBaselineSec(video, meetingBaseline) {
  const tst = parseTimestampToSec(video && video.transcript_start_time);
  if (tst !== null) return tst;
  if (meetingBaseline !== undefined && meetingBaseline !== null) {
    return typeof meetingBaseline === 'number'
      ? meetingBaseline
      : (parseTimestampToSec(meetingBaseline) ?? 0);
  }
  return 0;
}

/**
 * Pick the video part covering a segment: the part whose baseline is the
 * latest one at or before the segment, measured with midnight wrap. Falls
 * back to the first part. Returns { video, elapsed } or null.
 */
export function pickVideo(videos, segSec, meetingBaseline) {
  if (!videos || !videos.length) return null;
  let best = null;
  let bestElapsed = Infinity;
  for (const v of videos) {
    const elapsed = secondsSince(resolveBaselineSec(v, meetingBaseline), segSec);
    if (elapsed >= 0 && elapsed < bestElapsed) {
      best = v;
      bestElapsed = elapsed;
    }
  }
  if (!best) {
    best = videos[0];
    bestElapsed = secondsSince(resolveBaselineSec(best, meetingBaseline), segSec);
  }
  return { video: best, elapsed: bestElapsed };
}

/**
 * Resolve a segment timestamp to a video position.
 * Returns { seconds, videoPart, videoId } or null when it cannot.
 */
export function seekPosition(segTimestamp, videos, meetingBaseline) {
  if (!videos || !videos.length || !segTimestamp) return null;
  const segSec = parseTimestampToSec(segTimestamp);
  if (segSec === null) return null;
  const pick = pickVideo(videos, segSec, meetingBaseline);
  if (!pick) return null;
  const seconds = Math.max(0, (pick.video.offset_seconds || 0) + pick.elapsed);
  return { seconds, videoPart: pick.video.part, videoId: pick.video.video_id };
}

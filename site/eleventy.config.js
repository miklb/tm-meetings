module.exports = function (eleventyConfig) {
  // Passthrough copy for static assets
  eleventyConfig.addPassthroughCopy({ public: '.' });

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  const TYPE_LABELS = {
    regular: 'City Council',
    evening: 'Evening Session',
    cra: 'CRA',
    workshop: 'Workshop',
    special: 'Special Meeting',
  };

  /** Convert meeting_type slug to display name */
  eleventyConfig.addFilter('meetingTypeLabel', (type) => TYPE_LABELS[type] || type);

  /** Format YYYY-MM-DD as a readable date */
  eleventyConfig.addFilter('readableDate', (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  });

  /** Format YYYY-MM-DD as short date */
  eleventyConfig.addFilter('shortDate', (dateStr) => {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  });

  /** YouTube thumbnail URL from video ID */
  eleventyConfig.addFilter('ytThumb', (videoId) => {
    if (!videoId) return null;
    return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  });

  /** Strip "File No. XX-XXXX\n" prefix from item titles */
  eleventyConfig.addFilter('cleanTitle', (title) => {
    if (!title) return '';
    return title.replace(/^File No\.\s*[A-Z0-9-]+\s*\n?/i, '').trim();
  });

  /** Check if a string is non-empty after trimming */
  eleventyConfig.addFilter('hasContent', (str) => {
    return str && str.trim().length > 0;
  });

  /**
   * Parse a transcript wall-clock timestamp like "9:15:50AM" or "01:02:10PM"
   * into seconds since midnight.
   */
  function parseTimestampToSec(ts) {
    if (!ts) return null;
    // Handle both "9:15:50AM" and "09:15:50 AM" forms
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
   * Given a segment timestamp string and the meeting's videos array,
   * return a YouTube URL (https://youtu.be/{id}?t={sec}) pointing to the
   * correct position in the correct video part. Returns null if no match.
   */
  /**
   * Resolve the baseline for a video: its transcript_start_time if present,
   * otherwise the meeting's first transcript timestamp ("meeting baseline").
   */
  function resolveBaselineSec(video, meetingBaseline) {
    const tst = parseTimestampToSec(video.transcript_start_time);
    if (tst !== null) return tst;
    if (meetingBaseline !== undefined && meetingBaseline !== null) {
      return typeof meetingBaseline === 'number'
        ? meetingBaseline
        : (parseTimestampToSec(meetingBaseline) ?? 0);
    }
    return 0;
  }

  eleventyConfig.addFilter('youtubeUrl', (segTimestamp, videos, meetingBaseline) => {
    if (!videos || !videos.length || !segTimestamp) return null;
    const segSec = parseTimestampToSec(segTimestamp);
    if (segSec === null) return null;

    // Find the video part whose transcript_start_time is closest to (but ≤) the segment time.
    // Videos are ordered by part; pick the last one whose start ≤ segSec.
    let bestVideo = null;
    let bestStartSec = -Infinity;
    for (const v of videos) {
      const startSec = resolveBaselineSec(v, meetingBaseline);
      if (startSec <= segSec && startSec > bestStartSec) {
        bestStartSec = startSec;
        bestVideo = v;
      }
    }
    // Fall back to part 1 if none matched
    if (!bestVideo) bestVideo = videos[0];
    if (!bestVideo) return null;

    const startSec = resolveBaselineSec(bestVideo, meetingBaseline);
    const videoSec = Math.max(0, bestVideo.offset_seconds + (segSec - startSec));
    return `https://youtu.be/${bestVideo.video_id}?t=${videoSec}`;
  });

  /**
   * Given a segment timestamp and videos array, return an object with
   * { seconds, videoPart } for in-page YouTube IFrame API seeking.
   * Used to set data- attributes on transcript segments.
   */
  eleventyConfig.addFilter('videoSeekData', (segTimestamp, videos, meetingBaseline) => {
    if (!videos || !videos.length || !segTimestamp) return null;
    const segSec = parseTimestampToSec(segTimestamp);
    if (segSec === null) return null;

    let bestVideo = null;
    let bestStartSec = -Infinity;
    for (const v of videos) {
      const startSec = resolveBaselineSec(v, meetingBaseline);
      if (startSec <= segSec && startSec > bestStartSec) {
        bestStartSec = startSec;
        bestVideo = v;
      }
    }
    if (!bestVideo) bestVideo = videos[0];
    if (!bestVideo) return null;

    const startSec = resolveBaselineSec(bestVideo, meetingBaseline);
    const videoSec = Math.max(0, bestVideo.offset_seconds + (segSec - startSec));
    return { seconds: videoSec, videoPart: bestVideo.part };
  });

  return {
    dir: {
      input: 'src',
      output: '_site',
      includes: '_includes',
      data: '_data',
    },
    markdownTemplateEngine: 'njk',
    htmlTemplateEngine: 'njk',
  };
};

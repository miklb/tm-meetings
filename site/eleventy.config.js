const { seekPosition } = require('./lib/seek-math.js');

module.exports = function (eleventyConfig) {
  // Passthrough copy for static assets
  eleventyConfig.addPassthroughCopy({ public: '.' });

  // Current year — used in the shared site-footer colophon.
  eleventyConfig.addShortcode('year', () => `${new Date().getFullYear()}`);

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

  /** Format a video position in seconds as HH:MM:SS. */
  eleventyConfig.addFilter('hms', (sec) => {
    sec = Math.max(0, Math.round(sec || 0));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  });

  /**
   * Transcript-to-video seek math lives in lib/seek-math.js so it can be unit
   * tested (site/test/seek-math.test.js) and so the midnight wrap for
   * evening sessions that run past 12:00 AM is in one place.
   */

  /**
   * Given a segment timestamp string and the meeting's videos array,
   * return a YouTube URL (https://youtu.be/{id}?t={sec}) pointing to the
   * correct position in the correct video part. Returns null if no match.
   */
  eleventyConfig.addFilter('youtubeUrl', (segTimestamp, videos, meetingBaseline) => {
    const pos = seekPosition(segTimestamp, videos, meetingBaseline);
    return pos ? `https://youtu.be/${pos.videoId}?t=${pos.seconds}` : null;
  });

  /**
   * Given a segment timestamp and videos array, return
   * { seconds, videoPart, videoId } for in-page YouTube IFrame API seeking.
   * Used to set data- attributes on transcript segments.
   */
  eleventyConfig.addFilter('videoSeekData', (segTimestamp, videos, meetingBaseline) =>
    seekPosition(segTimestamp, videos, meetingBaseline));

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

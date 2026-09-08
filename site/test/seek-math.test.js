// Seek math: transcript wall-clock → video position, including midnight wrap.
// Run: npm test (root) or node --test site/test/seek-math.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimestampToSec,
  secondsSince,
  resolveBaselineSec,
  pickVideo,
  seekPosition,
  SECONDS_PER_DAY,
} from '../lib/seek-math.js';

test('parseTimestampToSec handles clerk formats', () => {
  assert.equal(parseTimestampToSec('9:15:50AM'), 9 * 3600 + 15 * 60 + 50);
  assert.equal(parseTimestampToSec('12:02:47PM'), 12 * 3600 + 2 * 60 + 47);
  assert.equal(parseTimestampToSec('12:32:11AM'), 32 * 60 + 11);
  assert.equal(parseTimestampToSec('01:02:10 PM'), 13 * 3600 + 2 * 60 + 10);
  assert.equal(parseTimestampToSec('not a time'), null);
  assert.equal(parseTimestampToSec(''), null);
  assert.equal(parseTimestampToSec(null), null);
});

test('secondsSince wraps across midnight and keeps small negatives', () => {
  const pm506 = parseTimestampToSec('5:06:25PM');
  const am304 = parseTimestampToSec('3:04:56AM');
  assert.equal(secondsSince(pm506, pm506 + 90), 90);
  // Meeting 2652: evening session ending at 3:04 AM the next morning
  assert.equal(secondsSince(pm506, am304), am304 - pm506 + SECONDS_PER_DAY);
  // A clerk stamp a few seconds before the baseline stays negative (caller clamps)
  assert.equal(secondsSince(pm506, pm506 - 5), -5);
});

test('resolveBaselineSec prefers transcript_start_time, then meeting baseline', () => {
  assert.equal(resolveBaselineSec({ transcript_start_time: '1:30:00PM' }, '9:00:00AM'), 13.5 * 3600);
  assert.equal(resolveBaselineSec({ transcript_start_time: null }, '9:00:00AM'), 9 * 3600);
  assert.equal(resolveBaselineSec({}, 1234), 1234);
  assert.equal(resolveBaselineSec({}, null), 0);
});

const singlePart = [{ video_id: 'QsXC_3wOViE', part: 1, offset_seconds: 607, transcript_start_time: null }];

test('post-midnight segment seeks forward instead of clamping to 0', () => {
  // Before the fix: 607 + (11096 − 61585) < 0 → clamped to 0
  const pos = seekPosition('3:04:56AM', singlePart, '5:06:25PM');
  assert.deepEqual(pos, {
    seconds: 607 + (parseTimestampToSec('3:04:56AM') - parseTimestampToSec('5:06:25PM') + SECONDS_PER_DAY),
    videoPart: 1,
    videoId: 'QsXC_3wOViE',
  });
  assert.ok(pos.seconds > 35000);
});

test('same-day segment math is unchanged', () => {
  assert.equal(seekPosition('5:16:25PM', singlePart, '5:06:25PM').seconds, 607 + 600);
  // A stamp 5 s before the baseline subtracts from the offset…
  assert.equal(seekPosition('5:06:20PM', singlePart, '5:06:25PM').seconds, 602);
  // …and only a negative result clamps to 0
  const tiny = [{ video_id: 't', part: 1, offset_seconds: 3, transcript_start_time: null }];
  assert.equal(seekPosition('5:06:20PM', tiny, '5:06:25PM').seconds, 0);
});

const twoParts = [
  { video_id: 'part1', part: 1, offset_seconds: 100, transcript_start_time: null },
  { video_id: 'part2', part: 2, offset_seconds: 50, transcript_start_time: '1:30:00PM' },
];

test('pickVideo chooses the latest part starting at or before the segment', () => {
  assert.equal(pickVideo(twoParts, parseTimestampToSec('9:10:00AM'), '9:00:00AM').video.part, 1);
  assert.equal(pickVideo(twoParts, parseTimestampToSec('1:30:00PM'), '9:00:00AM').video.part, 2);
  assert.equal(pickVideo(twoParts, parseTimestampToSec('1:45:00PM'), '9:00:00AM').video.part, 2);
  // Before every baseline: fall back to part 1
  assert.equal(pickVideo(twoParts, parseTimestampToSec('8:59:50AM'), '9:00:00AM').video.part, 1);
});

test('multi-part seek positions', () => {
  assert.deepEqual(seekPosition('9:10:00AM', twoParts, '9:00:00AM'),
    { seconds: 100 + 600, videoPart: 1, videoId: 'part1' });
  assert.deepEqual(seekPosition('1:45:00PM', twoParts, '9:00:00AM'),
    { seconds: 50 + 900, videoPart: 2, videoId: 'part2' });
  assert.equal(seekPosition('8:59:50AM', twoParts, '9:00:00AM').seconds, 100 - 10);
});

test('evening part 2 that crosses midnight stays on part 2', () => {
  const evening = [
    { video_id: 'e1', part: 1, offset_seconds: 300, transcript_start_time: null },
    { video_id: 'e2', part: 2, offset_seconds: 40, transcript_start_time: '7:00:00PM' },
  ];
  const pos = seekPosition('12:30:00AM', evening, '5:01:00PM');
  assert.deepEqual(pos, { seconds: 40 + 5.5 * 3600, videoPart: 2, videoId: 'e2' });
});

test('returns null without videos or a parseable timestamp', () => {
  assert.equal(seekPosition('9:10:00AM', [], '9:00:00AM'), null);
  assert.equal(seekPosition('', singlePart, '9:00:00AM'), null);
  assert.equal(seekPosition('garbage', singlePart, '9:00:00AM'), null);
});

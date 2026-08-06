#!/usr/bin/env python3
"""
Match Whisper transcription to official transcript and calculate video offset.

Workflow:
1. Try with cached Whisper JSON if it exists
2. If no cache, transcribe 5 minutes with Whisper
3. Try to match against official transcript
4. If no good match (>60% confidence), retry with 10 minutes
5. Cache the Whisper JSON for future use

This script takes:
1. Video ID or Whisper JSON output
2. Official transcript JSON

And calculates the video offset by finding where Whisper text matches official text.
"""

import json
import logging
import sys
import subprocess
import re
from collections import namedtuple
from difflib import SequenceMatcher
from pathlib import Path
from datetime import datetime

logger = logging.getLogger(__name__)


# Returned by calculate_smart_duration — tells the transcriber where to start
# extracting audio and how long to capture.
AudioWindow = namedtuple('AudioWindow', ['start', 'duration'])


def save_offset_to_mapping(video_mapping_file: str, video_id: str, offset: float) -> bool:
    """
    Write calculated offset_seconds into the video_mapping JSON file.

    Finds the video entry matching video_id and sets its offset_seconds.
    Creates a backup of the original file before modifying.

    Args:
        video_mapping_file: Path to video_mapping_<ID>.json
        video_id: YouTube video ID to update
        offset: Calculated offset in seconds

    Returns:
        True if saved successfully, False otherwise
    """
    path = Path(video_mapping_file)
    if not path.exists():
        logger.warning("  ⚠️  Video mapping file not found: %s", video_mapping_file)
        return False

    try:
        with open(path, 'r') as f:
            mapping = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning("  ⚠️  Could not read video mapping: %s", e)
        return False

    # Find and update the matching video entry
    updated = False
    for video in mapping.get('videos', []):
        if video.get('video_id') == video_id:
            video['offset_seconds'] = int(round(offset))
            updated = True
            break

    if not updated:
        logger.warning("  ⚠️  Video ID '%s' not found in %s", video_id, path.name)
        return False

    # Write back
    with open(path, 'w') as f:
        json.dump(mapping, f, indent=2)

    logger.info("  ✅ Saved offset_seconds=%d to %s for video %s",
                int(round(offset)), path.name, video_id)
    return True


def parse_iso_duration(duration_str):
    """Parse ISO 8601 duration like PT3H42M50S to seconds."""
    if not duration_str or not duration_str.startswith('PT'):
        return None
    
    duration_str = duration_str[2:]  # Remove PT
    hours = minutes = seconds = 0
    
    # Extract hours
    if 'H' in duration_str:
        h_parts = duration_str.split('H')
        hours = int(h_parts[0])
        duration_str = h_parts[1]
    
    # Extract minutes
    if 'M' in duration_str:
        m_parts = duration_str.split('M')
        minutes = int(m_parts[0])
        duration_str = m_parts[1]
    
    # Extract seconds
    if 'S' in duration_str:
        seconds = int(duration_str.replace('S', ''))
    
    return hours * 3600 + minutes * 60 + seconds


def parse_timestamp_to_seconds(timestamp_str):
    """Convert '9:01:40AM' or '4:20:26PM' to seconds from midnight."""
    # Handle 12-hour format with AM/PM
    timestamp_str = timestamp_str.strip().upper()
    
    # Parse with 12-hour format
    try:
        dt = datetime.strptime(timestamp_str, '%I:%M:%S%p')
    except ValueError:
        # Try without seconds
        dt = datetime.strptime(timestamp_str, '%I:%M%p')
    
    # Convert to seconds from midnight
    hours = dt.hour
    minutes = dt.minute
    seconds = dt.second
    
    return hours * 3600 + minutes * 60 + seconds


def calculate_smart_duration(video_mapping_file: str, transcript_file: str, video_id: str) -> 'AudioWindow':
    """
    Calculate optimal Whisper audio extraction window using the transcript's
    first segment timestamp to estimate where speech begins in the video.

    When the estimated speech position is far enough into the video, the
    function returns a non-zero ``start`` so the caller can skip the b-roll
    (countdown / music / silence) and only download the portion of audio
    that actually contains speech.  This dramatically reduces both download
    and Whisper processing time.

    Part 1 logic (transcript-based):
        estimated_speech_time = PRE_ROLL + speech_delay, capped at chapter[1]
        (speech has started *by* the first agenda-item marker — call to order,
        invocation, and roll call come before it).

        Always capture from the video start:
            start  = 0
            duration = clamp(estimated_speech_time + MATCH_BUFFER,
                             DEFAULT_DURATION, MAX_PART1_DURATION)

        Sampling from 0 lets the word-anchor matcher pin the transcript's
        opening segments — anchoring segment 0 measures the offset with no
        clerk-latency differential.  The VAD filter strips pre-roll music
        before transcription, so dead air costs download time only.

        Morning meetings (8 AM–noon):  schedule = 9:00 AM
        Evening meetings (≥ 5 PM):     schedule = 5:00 PM
        Other times:                   fallback to DEFAULT_DURATION, start = 0

    Part 2+ logic:
        With chapters  → start=0, duration = chapter[1].seconds + CHAPTER_BUFFER
        Without        → start=0, duration = PART2_NO_CHAPTERS_DURATION (900 s)

    Args:
        video_mapping_file: Path to video_mapping_<ID>.json
        transcript_file: Path to processed transcript JSON
        video_id: YouTube video ID to look up in the mapping

    Returns:
        AudioWindow(start, duration) where *start* is the ffmpeg seek offset
        (seconds into the video) and *duration* is how many seconds to capture.
    """
    DEFAULT_DURATION = 600                # 10-min minimum
    MAX_PART1_DURATION = 900              # 15-min ceiling for Part 1 capture
    PART2_NO_CHAPTERS_DURATION = 900      # 15-min fallback for Part 2+
    CHAPTER_BUFFER = 120                  # 2-min buffer past first content chapter
    PRE_ROLL = 300                        # 5 min — video starts before scheduled time
    MATCH_BUFFER = 180                    # 3 min — enough speech for Whisper matching

    # Schedule windows (seconds from midnight)
    MORNING_WINDOW_START = 8 * 3600       # 8:00 AM
    MORNING_WINDOW_END = 12 * 3600        # 12:00 PM (noon)
    MORNING_SCHEDULE = 9 * 3600           # 9:00 AM
    EVENING_WINDOW_START = 17 * 3600      # 5:00 PM
    EVENING_SCHEDULE = 17 * 3600          # 5:00 PM

    # --- Load video mapping and find the target video entry ---
    part = 1
    chapters = []
    try:
        with open(video_mapping_file, 'r') as f:
            mapping = json.load(f)
        for video in mapping.get('videos', []):
            if video.get('video_id') == video_id:
                part = video.get('part', 1)
                chapters = video.get('chapters', [])
                break
        else:
            logger.warning("  ⚠️  Video '%s' not found in mapping — using defaults", video_id)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning("  ⚠️  Could not read video mapping for smart duration: %s", e)

    # --- Read first segment timestamp from transcript ---
    first_speech_seconds = None
    try:
        with open(transcript_file, 'r') as f:
            transcript = json.load(f)
        segments = transcript.get('segments', transcript.get('transcript', []))
        if segments:
            first_ts = segments[0].get('timestamp', '')
            if first_ts:
                first_speech_seconds = parse_timestamp_to_seconds(first_ts)
    except (json.JSONDecodeError, IOError, ValueError):
        pass  # Non-critical — proceed with defaults

    # --- Apply duration rules ---
    start = 0

    if part == 1:
        if first_speech_seconds is not None:
            # Determine assumed schedule start based on time window
            if MORNING_WINDOW_START <= first_speech_seconds < MORNING_WINDOW_END:
                schedule_start = MORNING_SCHEDULE
                session_label = "morning"
            elif first_speech_seconds >= EVENING_WINDOW_START:
                schedule_start = EVENING_SCHEDULE
                session_label = "evening"
            else:
                schedule_start = None
                session_label = None

            if schedule_start is not None:
                speech_delay = first_speech_seconds - schedule_start
                estimated_speech = PRE_ROLL + speech_delay

                # Chapter semantics:
                #   chapter[0] is always 0:00 = video start (NOT speech start)
                #     — always ignored.
                #   chapter[1] is the first real agenda-item marker. Speech has
                #     started *by* then (call to order, invocation, and roll
                #     call come before the first agenda item), so it is a
                #     CEILING on speech start — never an estimate of it.
                if len(chapters) > 1:
                    first_chapter_secs = chapters[1].get('seconds', 0)
                    if 0 < first_chapter_secs < estimated_speech:
                        estimated_speech = first_chapter_secs

                # Always capture from the video start so the word-anchor
                # matcher can pin the transcript's opening segments —
                # anchoring segment 0 measures the offset with no
                # clerk-latency differential.  The VAD filter strips
                # pre-roll music before transcription, so the dead air
                # costs download time only.
                start = 0
                duration = int(min(max(DEFAULT_DURATION,
                                       estimated_speech + MATCH_BUFFER),
                                   MAX_PART1_DURATION))
                delay_min = speech_delay / 60
                reason = (f"Part 1 {session_label} — capture from 0 through "
                          f"est. speech at {estimated_speech:.0f}s "
                          f"(~{delay_min:.0f}m after schedule) + "
                          f"{MATCH_BUFFER // 60}m match buffer")
            else:
                duration = DEFAULT_DURATION
                reason = "Part 1 — non-standard meeting time, using default"
        else:
            duration = DEFAULT_DURATION
            reason = "Part 1 — no transcript timestamp, using default"

    elif len(chapters) > 1:
        # Part 2+ chapter semantics:
        #   chapter[0] — always 00:00, labeled "Start of Meeting" but actually
        #     the start of the *video*. USELESS as a speech anchor; ignore it.
        #   chapter[1] — first real agenda-item marker. Speech has started
        #     *by* this timestamp; it's an upper bound / ceiling, not the
        #     actual start. Speech typically begins shortly before this marker
        #     (often within 30–60s), after countdown/slate fades.
        #
        # Strategy: center the sample window on chapter[1] — capture a little
        # before (to catch the opening remarks) and continuing past it so
        # Whisper has several minutes of real speech to latch onto.
        PART2_PRE_CHAPTER_MARGIN = 60     # 1 min before chapter[1] (tight)
        PART2_POST_CHAPTER_MARGIN = 300   # 5 min after chapter[1]
        first_content_secs = chapters[1].get('seconds', 0)
        if first_content_secs > PART2_PRE_CHAPTER_MARGIN:
            start = first_content_secs - PART2_PRE_CHAPTER_MARGIN
            duration = PART2_PRE_CHAPTER_MARGIN + PART2_POST_CHAPTER_MARGIN
            reason = (f"Part {part} — center on chapter[1]={first_content_secs}s "
                      f"(speech starts shortly before it); "
                      f"skip to {start}s, capture {duration}s "
                      f"({PART2_PRE_CHAPTER_MARGIN}s pre + "
                      f"{PART2_POST_CHAPTER_MARGIN}s post)")
        else:
            # Chapter is very early — just capture from the start
            duration = max(DEFAULT_DURATION,
                           first_content_secs + CHAPTER_BUFFER)
            reason = (f"Part {part} — chapter[1] at {first_content_secs}s "
                      f"is too early for pre-margin, starting from 0")
    else:
        duration = PART2_NO_CHAPTERS_DURATION
        reason = f"Part {part} — no chapter data, conservative {PART2_NO_CHAPTERS_DURATION}s"

    if start > 0:
        logger.info("  📐 Smart duration: skip to %ds (%d:%02d), capture %ds (%d:%02d) — %s",
                    start, start // 60, start % 60, duration, duration // 60, duration % 60, reason)
    else:
        logger.info("  📐 Smart duration: %ds (%d:%02d) — %s",
                    duration, duration // 60, duration % 60, reason)
    return AudioWindow(start=start, duration=duration)


NON_ASCII_RE = re.compile(r'[^A-Z0-9\s]')


def normalize_text(text):
    """Normalize text for comparison - uppercase, drop non-ASCII, collapse whitespace."""
    text = text.upper().strip()
    # Replace punctuation and symbols with spaces
    text = NON_ASCII_RE.sub(' ', text)
    return ' '.join(text.split())


# Common English stop words to exclude from keyword matching
STOP_WORDS = frozenset({
    'THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAD',
    'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HIS', 'HOW', 'ITS', 'LET',
    'MAY', 'NEW', 'NOW', 'OLD', 'SEE', 'WAY', 'WHO', 'DID', 'GET', 'GOT',
    'HIM', 'HIT', 'OWN', 'SAY', 'SHE', 'TOO', 'USE', 'THAT', 'WITH',
    'HAVE', 'THIS', 'WILL', 'YOUR', 'FROM', 'THEY', 'BEEN', 'SAID',
    'EACH', 'WHICH', 'THEIR', 'THEM', 'THEN', 'THAN', 'SOME', 'WERE',
    'THERE', 'WHERE', 'WHAT', 'WHEN', 'MAKE', 'LIKE', 'JUST', 'OVER',
    'SUCH', 'TAKE', 'INTO', 'VERY', 'ALSO', 'BACK', 'GOOD', 'WELL',
    'HERE', 'COME', 'CAME', 'KNOW', 'MUCH', 'ABOUT', 'WOULD', 'COULD',
    'SHOULD', 'GOING', 'THINK', 'THANK', 'MORNING', 'EVENING',
})


def extract_content_words(text):
    """Extract meaningful content words from text, filtering stop words."""
    words = normalize_text(text).split()
    return [w for w in words if len(w) >= 3 and any(c.isalpha() for c in w)
            and w not in STOP_WORDS]


def ngram_match_score(whisper_words, official_words, n=4):
    """Score how well Whisper n-grams match official transcript.

    Uses consecutive n-gram matching: builds all n-grams from the official
    text and checks how many Whisper n-grams appear as substrings.
    This prevents false positives from common words coincidentally appearing
    in unrelated text.

    Returns:
        Fraction of Whisper n-grams found in official text (0.0–1.0)
    """
    if len(whisper_words) < n or len(official_words) < n:
        # Fall back to individual word matching for short texts
        if not whisper_words:
            return 0.0
        matches = sum(1 for w in whisper_words if w in official_words)
        return matches / len(whisper_words)

    # Build n-grams from both sides
    whisper_ngrams = [tuple(whisper_words[i:i+n]) for i in range(len(whisper_words) - n + 1)]
    official_ngrams = set(tuple(official_words[i:i+n]) for i in range(len(official_words) - n + 1))

    if not whisper_ngrams:
        return 0.0

    matched = sum(1 for ng in whisper_ngrams if ng in official_ngrams)
    return matched / len(whisper_ngrams)


def estimate_char_position(whisper_text, official_text):
    """Estimate where whisper_text falls within official_text using character positions.

    Character position correlates better with speech duration than content-word
    position (which compresses stop-word-heavy regions like conversational
    openings).  Falls back to None if no substring match is found, so the
    caller can use the content-word sliding window instead.

    Returns:
        Float 0.0–1.0 representing the fractional start position, or None.
    """
    w_norm = normalize_text(whisper_text)
    o_norm = normalize_text(official_text)

    if not w_norm or not o_norm:
        return None

    # Try full normalized text as substring
    idx = o_norm.find(w_norm)
    if idx >= 0:
        return idx / len(o_norm)

    # Try progressively shorter substrings (trim noisy edges)
    w_words = w_norm.split()
    for trim in range(1, len(w_words) // 2):
        substr = ' '.join(w_words[trim:-trim])
        if len(substr.split()) < 3:
            break
        idx = o_norm.find(substr)
        if idx >= 0:
            return idx / len(o_norm)

    return None


def find_match_position(whisper_content_words, official_content_words):
    """Find where in the official content words the Whisper text best matches.

    Slides a window the size of the Whisper content words across the official
    content words, computing word overlap at each position.

    Returns:
        (best_position_frac, best_overlap) where position_frac is 0..1
        indicating how far into the official text the best match appears.
    """
    w_len = len(whisper_content_words)
    o_len = len(official_content_words)

    if w_len == 0 or o_len == 0:
        return 0.5, 0.0

    if o_len <= w_len:
        # Official text is shorter; check overall overlap
        w_set = set(whisper_content_words)
        o_set = set(official_content_words)
        overlap = len(w_set & o_set) / len(w_set) if w_set else 0.0
        return 0.0, overlap

    w_set = set(whisper_content_words)
    best_overlap = 0.0
    best_pos = 0

    for i in range(o_len - w_len + 1):
        window = set(official_content_words[i:i + w_len])
        overlap = len(w_set & window) / len(w_set)
        if overlap > best_overlap:
            best_overlap = overlap
            best_pos = i

    position_frac = best_pos / (o_len - w_len) if o_len > w_len else 0.0
    return position_frac, best_overlap


# ── Word-anchor offset calculation ─────────────────────────────────────────────
# Official transcript timestamps mark where each segment *begins*, so a
# segment's opening words are pinned to a known transcript time.  When the
# Whisper output carries word-level timestamps (faster-whisper), locating those
# opening words in the word stream reads the offset directly — no intra-segment
# position interpolation.  Each anchored segment is an independent measurement;
# the median of the agreeing measurements is the offset.

ANCHOR_PHRASE_WORDS = 8    # official opening words per anchor
ANCHOR_MIN_RATIO = 0.75    # SequenceMatcher ratio to accept a position
ANCHOR_TOLERANCE = 15      # seconds — agreeing anchors cluster within this
ANCHOR_MIN_SUPPORT = 3     # independent anchors required for a result


def _anchor_words(text):
    """Normalized word list for anchor matching, minus [bracketed] annotations."""
    text = re.sub(r'\[[^\]]*\]', ' ', text)
    return normalize_text(text).split()


def calculate_offset_by_anchors(whisper_segments, official_segments, first_seconds):
    """Calculate offset by anchoring official segment openings in Whisper words.

    Returns the median offset in seconds, or None when inconclusive (no word
    timestamps, too few anchors, or no agreement) — callers should fall back
    to n-gram cluster matching.
    """
    # Flatten the Whisper word stream. A single Whisper word can normalize to
    # multiple tokens ("it's" → IT S); emit each with the same start time so
    # both sides tokenize identically.
    stream = []
    for seg in whisper_segments:
        for w in seg.get('words', []):
            for token in normalize_text(w['word']).split():
                stream.append((w['start'], token))

    if len(stream) < ANCHOR_PHRASE_WORDS:
        logger.info("  Anchor matching: no word-level timestamps in Whisper output")
        return None

    word_list = [t for _, t in stream]

    # Same ~20-minute search window as the n-gram matcher
    cutoff_secs = first_seconds + 20 * 60
    anchors = []
    skipped_ambiguous = 0

    for o_idx, o_seg in enumerate(official_segments[:100]):
        o_ts = o_seg.get('timestamp')
        o_text = o_seg.get('text', '')
        if not o_ts or not o_text:
            continue
        o_secs = parse_timestamp_to_seconds(o_ts)
        if o_secs > cutoff_secs:
            break

        o_words = _anchor_words(o_text)[:ANCHOR_PHRASE_WORDS]
        # Require enough distinctive material to anchor on
        if len(o_words) < 5 or sum(1 for w in o_words if len(w) >= 4) < 3:
            continue

        n = len(o_words)
        hits = []  # (ratio, stream position)
        for i in range(len(word_list) - n + 1):
            ratio = SequenceMatcher(None, o_words, word_list[i:i + n]).ratio()
            if ratio >= ANCHOR_MIN_RATIO:
                hits.append((ratio, i))
        if not hits:
            continue

        # If positions above threshold imply offsets further apart than the
        # tolerance, the phrase repeats in the audio — unusable as an anchor.
        implied = [stream[i][0] - (o_secs - first_seconds) for _, i in hits]
        if max(implied) - min(implied) > ANCHOR_TOLERANCE:
            skipped_ambiguous += 1
            continue

        ratio, i = max(hits)
        anchors.append({
            'official_index': o_idx,
            'timestamp': o_ts,
            'ratio': ratio,
            'whisper_time': stream[i][0],
            'offset': stream[i][0] - (o_secs - first_seconds),
            'phrase': ' '.join(o_words),
        })

    if not anchors:
        logger.info("  Anchor matching: no official segment openings found in "
                    "Whisper words (%d ambiguous skipped)", skipped_ambiguous)
        return None

    # Cluster anchors by offset; the largest agreeing cluster wins
    anchors.sort(key=lambda a: a['offset'])
    clusters = []
    current = [anchors[0]]
    for a in anchors[1:]:
        if a['offset'] - current[0]['offset'] <= ANCHOR_TOLERANCE:
            current.append(a)
        else:
            clusters.append(current)
            current = [a]
    clusters.append(current)
    clusters.sort(key=len, reverse=True)
    best = clusters[0]

    logger.info("\n  Word-anchor matching: %d anchor(s), %d cluster(s)%s",
                len(anchors), len(clusters),
                f", {skipped_ambiguous} ambiguous skipped" if skipped_ambiguous else "")
    for a in best[:8]:
        logger.info("    ⚓ seg %d %s → %.1fs  offset %.1fs  (ratio %.2f)  \"%s\"",
                    a['official_index'], a['timestamp'], a['whisper_time'],
                    a['offset'], a['ratio'], a['phrase'][:60])
    if len(best) > 8:
        logger.info("    … and %d more in cluster", len(best) - 8)

    if len(best) < ANCHOR_MIN_SUPPORT:
        logger.info("  Anchor matching: only %d agreeing anchor(s) (<%d) — inconclusive",
                    len(best), ANCHOR_MIN_SUPPORT)
        return None

    # Prefer a strong anchor on the baseline segment itself: its timestamp IS
    # the baseline, so its offset carries no clerk-latency differential.
    seg0 = next((a for a in best
                 if a['official_index'] == 0 and a['ratio'] >= 0.85), None)
    if seg0 is not None:
        logger.info("  ✓ %d agreeing anchors; baseline segment anchored directly "
                    "— offset %.1fs (ratio %.2f)",
                    len(best), seg0['offset'], seg0['ratio'])
        return seg0['offset']

    offsets = sorted(a['offset'] for a in best)
    median = offsets[len(offsets) // 2]
    spread = offsets[-1] - offsets[0]
    logger.info("  ✓ %d agreeing anchors, median offset %.1fs (spread %.1fs)",
                len(best), median, spread)
    return median


def find_best_match(whisper_segments, official_segments, first_seconds=None):
    """
    Find where Whisper speech appears in the official transcript.

    Scans ALL Whisper segments with meaningful content and scores them against
    the first several official transcript segments using n-gram matching.
    Then applies **cross-validation** — computing the implied offset for each
    match and selecting the offset cluster with the most independent supporting
    matches.  This prevents garbled / hallucinated Whisper text (common during
    countdown screens) from dominating the result.

    Args:
        whisper_segments: list of Whisper segment dicts
        official_segments: list of official transcript segment dicts
        first_seconds: seconds-from-midnight of the first official segment
                       (needed for offset cross-validation)

    Returns:
        dict with match info or None if no good match found
    """
    logger.info("\nSearching for speech match...")

    MIN_SCORE = 0.3        # At least 30% of n-grams must match
    OFFSET_TOLERANCE = 30  # Seconds — matches within this range cluster together

    def collect_candidates(min_content_words):
        found = []
        for w_seg in whisper_segments:
            if w_seg.get('no_speech_prob', 0) > 0.5:
                continue

            w_text = w_seg['text'].strip()

            # Must be mostly ASCII
            ascii_chars = sum(1 for c in w_text if ord(c) < 128)
            if len(w_text) > 0 and ascii_chars / len(w_text) < 0.85:
                continue

            content_words = extract_content_words(w_text)

            # Avoid numeric/symbolic junk like "2. 1." that can survive no_speech filtering.
            alpha_chars = sum(1 for c in w_text if c.isalpha())
            if alpha_chars < 6:
                continue

            if len(content_words) >= min_content_words:
                found.append({
                    'text': w_text,
                    'start': w_seg['start'],
                    'content_words': content_words,
                })
        return found

    # First pass: strict filter. Second pass: allow shorter procedural speech.
    candidates = collect_candidates(4)
    if not candidates:
        logger.warning("  ⚠️  No candidates with >=4 content words; retrying with >=3")
        candidates = collect_candidates(3)

    if not candidates:
        logger.error("ERROR: No meaningful speech found in Whisper output")
        return None

    logger.info("  Found %d candidate Whisper segments to try", len(candidates))

    # Compare against official segments covering at least the first 20 min
    # of transcript time.  Workshops can have 40+ short segments (roll call,
    # procedural remarks) before the content that Whisper captures, so a
    # fixed count of 10 is far too small.
    max_official = len(official_segments)  # default: scan all
    if first_seconds is not None and len(official_segments) > 10:
        cutoff_secs = first_seconds + 20 * 60  # 20 minutes from start
        for idx, seg in enumerate(official_segments):
            ts = seg.get('timestamp')
            if ts:
                seg_secs = parse_timestamp_to_seconds(ts)
                if seg_secs > cutoff_secs:
                    max_official = max(idx, 10)  # at least 10
                    break
    max_official = min(max_official, len(official_segments))

    # Precompute segment durations from consecutive timestamps
    seg_durations = {}  # o_idx -> duration in seconds
    for o_idx in range(max_official):
        o_ts = official_segments[o_idx].get('timestamp')
        if not o_ts or first_seconds is None:
            continue
        o_secs = parse_timestamp_to_seconds(o_ts)
        # Duration = time until the next segment starts
        if o_idx + 1 < len(official_segments):
            next_ts = official_segments[o_idx + 1].get('timestamp')
            if next_ts:
                next_secs = parse_timestamp_to_seconds(next_ts)
                seg_durations[o_idx] = next_secs - o_secs
        if o_idx not in seg_durations:
            seg_durations[o_idx] = 30  # default assumption

    # Score every (candidate, official_segment) pair
    all_matches = []
    for c_idx, candidate in enumerate(candidates):
        whisper_cw = candidate['content_words']
        w_start = candidate['start']
        w_text = candidate['text']

        for o_idx in range(max_official):
            o_seg = official_segments[o_idx]
            o_text = o_seg.get('text', '')
            o_timestamp = o_seg.get('timestamp')

            if not o_text or not o_timestamp:
                continue

            o_content_words = extract_content_words(o_text)
            score = ngram_match_score(whisper_cw, o_content_words, n=3)

            if score >= MIN_SCORE:
                # Find WHERE in the official segment the match appears.
                # Prefer character-based position (correlates better with
                # speech duration); fall back to content-word sliding window.
                char_frac = estimate_char_position(w_text, o_text)
                if char_frac is not None:
                    position_frac = char_frac
                else:
                    position_frac, _ = find_match_position(whisper_cw, o_content_words)

                # Compute position-adjusted offset
                implied_offset = None
                if first_seconds is not None:
                    o_seconds = parse_timestamp_to_seconds(o_timestamp)
                    secs_from_start = o_seconds - first_seconds
                    # Adjust for position within the segment
                    seg_dur = seg_durations.get(o_idx, 30)
                    adjusted_secs = secs_from_start + position_frac * seg_dur
                    implied_offset = w_start - adjusted_secs

                all_matches.append({
                    'whisper_start': w_start,
                    'whisper_text': w_text,
                    'official_index': o_idx,
                    'official_timestamp': o_timestamp,
                    'official_text': o_text,
                    'score': score,
                    'candidate_idx': c_idx,
                    'implied_offset': implied_offset,
                    'position_frac': position_frac,
                    'seg_duration': seg_durations.get(o_idx, 30),
                })

    if not all_matches:
        logger.error("\nERROR: Could not find Whisper text in official transcript "
                     "(tried %d candidates, min score %s)", len(candidates), MIN_SCORE)
        return None

    logger.info("  %d matches above threshold", len(all_matches))

    # --- Early-segment fuzzy match ---
    # The earliest Whisper segments give the most accurate offset (minimal
    # interpolation), but Whisper base model often garbles proper nouns and
    # opening words, breaking n-gram chains. Try harder on the first few
    # candidates using bigrams + word overlap as a combined score.
    EARLY_CANDIDATES = 5
    EARLY_FUZZY_THRESHOLD = 0.35  # Combined score threshold
    early_fuzzy_matches = []

    for c_idx, candidate in enumerate(candidates[:EARLY_CANDIDATES]):
        whisper_cw = candidate['content_words']
        w_start = candidate['start']
        w_text = candidate['text']

        for o_idx in range(min(max_official, 15)):  # first 15 official segments
            o_seg = official_segments[o_idx]
            o_text = o_seg.get('text', '')
            o_timestamp = o_seg.get('timestamp')
            if not o_text or not o_timestamp:
                continue

            o_content_words = extract_content_words(o_text)

            # Already have a normal match for this pair? Skip.
            if any(m['candidate_idx'] == c_idx and m['official_index'] == o_idx
                   for m in all_matches):
                continue

            # Bigram score (more tolerant of single garbled words)
            bigram_score = ngram_match_score(whisper_cw, o_content_words, n=2)
            # Individual word overlap
            if whisper_cw:
                o_set = set(o_content_words)
                word_score = sum(1 for w in whisper_cw if w in o_set) / len(whisper_cw)
            else:
                word_score = 0.0

            # Combined: weight bigrams more (they still require consecutive pairs)
            combined = 0.6 * bigram_score + 0.4 * word_score

            if combined >= EARLY_FUZZY_THRESHOLD:
                char_frac = estimate_char_position(w_text, o_text)
                if char_frac is not None:
                    position_frac = char_frac
                else:
                    position_frac, _ = find_match_position(whisper_cw, o_content_words)

                implied_offset = None
                if first_seconds is not None:
                    o_seconds = parse_timestamp_to_seconds(o_timestamp)
                    secs_from_start = o_seconds - first_seconds
                    seg_dur = seg_durations.get(o_idx, 30)
                    adjusted_secs = secs_from_start + position_frac * seg_dur
                    implied_offset = w_start - adjusted_secs

                early_fuzzy_matches.append({
                    'whisper_start': w_start,
                    'whisper_text': w_text,
                    'official_index': o_idx,
                    'official_timestamp': o_timestamp,
                    'official_text': o_text,
                    'score': combined,
                    'candidate_idx': c_idx,
                    'implied_offset': implied_offset,
                    'position_frac': position_frac,
                    'seg_duration': seg_durations.get(o_idx, 30),
                    'fuzzy': True,
                })

    if early_fuzzy_matches:
        logger.info("  %d early fuzzy match(es) found (bigram + word overlap)", len(early_fuzzy_matches))

    # --- Cross-validation: cluster matches by implied offset ---
    clusters = []  # initialized for runner-up logging below
    if first_seconds is not None and len(all_matches) > 1:
        # Sort by implied offset for clustering
        by_offset = sorted(all_matches, key=lambda m: m['implied_offset'])

        # Greedy clustering within OFFSET_TOLERANCE
        clusters = []
        current_cluster = [by_offset[0]]
        for m in by_offset[1:]:
            if m['implied_offset'] - current_cluster[0]['implied_offset'] <= OFFSET_TOLERANCE:
                current_cluster.append(m)
            else:
                clusters.append(current_cluster)
                current_cluster = [m]
        clusters.append(current_cluster)

        # Count unique Whisper candidates per cluster (not just raw match count)
        def unique_candidates(cluster):
            return len(set(m['candidate_idx'] for m in cluster))  # noqa: defined in scope used by runner-up logging

        # Pick cluster with most unique supporting candidates
        clusters.sort(key=lambda c: (unique_candidates(c), max(m['score'] for m in c)), reverse=True)
        best_cluster = clusters[0]

        # Log cluster info
        logger.info("\n  Offset clusters: %d", len(clusters))
        for i, cl in enumerate(clusters[:4]):
            offsets = [m['implied_offset'] for m in cl]
            median_off = sorted(offsets)[len(offsets) // 2]
            logger.info("    Cluster %d: offset ~%.0fs, %d unique candidates, "
                        "%d total matches, best score %.2f",
                        i + 1, median_off, unique_candidates(cl),
                        len(cl), max(m['score'] for m in cl))

        # Within the winning cluster, pick match with highest score
        best_cluster.sort(key=lambda m: m['score'], reverse=True)
        best = best_cluster[0]

        # Use cluster median offset for robustness — individual matches may
        # have intra-segment interpolation error, but the median across many
        # independent matches averages it out.
        if len(best_cluster) >= 3:
            cluster_offsets = sorted(m['implied_offset'] for m in best_cluster)
            median_offset = cluster_offsets[len(cluster_offsets) // 2]
            best['implied_offset'] = median_offset
            best['cluster_median'] = True

        logger.info("\n✓ MATCHED Whisper candidate %d at %.1fs "
                    "to official segment %d at %s (score: %.2f, offset: %.0fs, "
                    "cluster support: %d candidates)",
                    best['candidate_idx'], best['whisper_start'],
                    best['official_index'], best['official_timestamp'],
                    best['score'], best['implied_offset'],
                    unique_candidates(best_cluster))

        # --- Early-segment preference ---
        # If an early fuzzy match has an implied offset within OFFSET_TOLERANCE
        # of the winning cluster median AND matches a short segment (≤60s),
        # prefer it — the offset is computed from the segment start with
        # minimal interpolation, so it's more precise.
        # Also check the normal matches for a candidate that matched official
        # segment 0 — that gives the most direct offset possible.
        early_preferred = None

        # First, check normal matches for a segment-0 match within cluster range
        cluster_median = best['implied_offset']
        for m in all_matches:
            if m['official_index'] == 0 and m['candidate_idx'] < EARLY_CANDIDATES:
                # Direct offset: whisper_start - 0 (first segment = meeting start)
                direct_offset = m['whisper_start']  # secs_from_start is 0 for segment 0
                if abs(direct_offset - cluster_median) <= OFFSET_TOLERANCE:
                    early_preferred = m
                    early_preferred['implied_offset'] = direct_offset
                    early_preferred['early_match'] = True
                    break

        # If no segment-0 match, try early fuzzy matches
        if not early_preferred and early_fuzzy_matches:
            for efm in sorted(early_fuzzy_matches, key=lambda m: m['candidate_idx']):
                if efm['implied_offset'] is None:
                    continue
                if abs(efm['implied_offset'] - cluster_median) <= OFFSET_TOLERANCE:
                    early_preferred = efm
                    early_preferred['early_match'] = True
                    break

        if early_preferred:
            logger.info("\n  ⚡ Early segment match (candidate %d) at %.1fs → segment %d "
                        "at %s (offset: %.0fs)",
                        early_preferred['candidate_idx'], early_preferred['whisper_start'],
                        early_preferred['official_index'], early_preferred['official_timestamp'],
                        early_preferred['implied_offset'])
            logger.info("     Whisper: \"%s\"", early_preferred['whisper_text'][:80])
            logger.info("     Using early segment offset (more precise, less interpolation)")
            best = early_preferred
    else:
        # Only one match or no baseline — just pick highest score
        all_matches.sort(key=lambda m: m['score'], reverse=True)
        best = all_matches[0]

        logger.info("\n✓ MATCHED Whisper candidate %d at %.1fs "
                    "to official segment %d at %s (score: %.2f)",
                    best['candidate_idx'], best['whisper_start'],
                    best['official_index'], best['official_timestamp'], best['score'])

    logger.info("  Whisper:  \"%s\"", best['whisper_text'][:80])
    logger.info("  Official: \"%s\"", best['official_text'][:80])

    # Log runner-up if from a different cluster
    if len(clusters) > 1:
        runner_cluster = clusters[1]
        runner = max(runner_cluster, key=lambda m: m['score'])
        logger.info("  Runner-up cluster: candidate %d at %.1fs → segment %d "
                    "at %s (score: %.2f, offset: %.0fs, %d candidates)",
                    runner['candidate_idx'], runner['whisper_start'],
                    runner['official_index'], runner['official_timestamp'],
                    runner['score'], runner['implied_offset'],
                    unique_candidates(runner_cluster))

    return best


def calculate_offset(whisper_json_file, official_transcript_file,
                     transcript_start_time=None):
    """
    Calculate video offset.

    Args:
        whisper_json_file: Path to cached Whisper JSON
        official_transcript_file: Path to official transcript JSON
        transcript_start_time: For Part 2+ videos, the timestamp (e.g.
            '02:03:39PM') where this video's portion of the transcript
            begins.  When set, only official segments at or after this
            time are searched, and the baseline is set to this time
            instead of the first segment.

    Returns:
        offset in seconds, or None if can't calculate
    """
    # Load Whisper output
    with open(whisper_json_file) as f:
        whisper_data = json.load(f)
    
    whisper_segments = whisper_data['segments']
    logger.info("✓ Loaded Whisper output: %d segments", len(whisper_segments))

    # Load official transcript
    with open(official_transcript_file) as f:
        official_data = json.load(f)

    official_segments = official_data['segments']
    logger.info("✓ Loaded official transcript: %d segments", len(official_segments))

    # For Part 2+ videos, filter to segments at/after transcript_start_time
    if transcript_start_time:
        start_secs = parse_timestamp_to_seconds(transcript_start_time)
        filtered = [s for s in official_segments
                    if s.get('timestamp') and
                    parse_timestamp_to_seconds(s['timestamp']) >= start_secs]
        if not filtered:
            logger.error("❌ No segments found at or after %s", transcript_start_time)
            return None
        logger.info("  Filtered to %d segments at/after %s (from %d total)",
                    len(filtered), transcript_start_time, len(official_segments))
        official_segments = filtered

    # Get baseline timestamp
    first_timestamp = official_segments[0].get('timestamp')
    if not first_timestamp:
        logger.error("❌ First official segment has no timestamp")
        return None

    first_seconds = parse_timestamp_to_seconds(first_timestamp)
    logger.info("  First official timestamp: %s (baseline)", first_timestamp)

    # Word-anchor pass — interpolation-free, available when the Whisper output
    # has word-level timestamps. Falls through to n-gram matching otherwise.
    anchor_offset = calculate_offset_by_anchors(whisper_segments,
                                                official_segments,
                                                first_seconds)
    if anchor_offset is not None:
        logger.info("\n✅ OFFSET: %.1f seconds (%d:%02d) — word-anchor method",
                    anchor_offset, int(anchor_offset // 60),
                    int(anchor_offset % 60))
        return anchor_offset
    logger.info("  Falling back to n-gram cluster matching…")

    # Find match (pass baseline for cross-validation)
    match = find_best_match(whisper_segments, official_segments,
                            first_seconds=first_seconds)
    
    if not match:
        logger.error("\n❌ No good match found")
        return None

    # Use the position-adjusted offset if available (from cross-validation),
    # otherwise fall back to segment-start-based offset
    if match.get('implied_offset') is not None:
        offset = match['implied_offset']
        position_frac = match.get('position_frac', 0.0)
        seg_dur = match.get('seg_duration', 0)
        official_seg_seconds = parse_timestamp_to_seconds(match['official_timestamp'])
        seconds_from_meeting_start = official_seg_seconds - first_seconds
        position_adjustment = position_frac * seg_dur
        whisper_video_time = match['whisper_start']
    else:
        official_seg_seconds = parse_timestamp_to_seconds(match['official_timestamp'])
        seconds_from_meeting_start = official_seg_seconds - first_seconds
        whisper_video_time = match['whisper_start']
        offset = whisper_video_time - seconds_from_meeting_start
        position_adjustment = 0
        position_frac = 0
        seg_dur = 0

    logger.info("\n" + "=" * 70)
    logger.info("✅ MATCH FOUND")
    logger.info("=" * 70)
    logger.info("Whisper first speech at %.1fs:", whisper_video_time)
    logger.info("  \"%s...\"", match['whisper_text'][:80])
    logger.info("\nFound in official segment %d at %s:",
                match['official_index'], match['official_timestamp'])
    logger.info("  \"%s...\"", match['official_text'][:80])
    logger.info("\nOffset Calculation:")
    logger.info("  Meeting baseline: %s (0 seconds)", first_timestamp)
    logger.info("  Official segment: %s (%.0fs from start)",
                match['official_timestamp'], seconds_from_meeting_start)
    if match.get('early_match') and match.get('official_index') == 0:
        logger.info("  Whisper video time: %.1fs", whisper_video_time)
        logger.info("  ")
        logger.info("  Offset = whisper_time (direct, first segment)")
        logger.info("  Offset = %.1fs", offset)
    elif position_adjustment > 1:
        logger.info("  Position within segment: %.0f%% of %.0fs = +%.1fs",
                    position_frac * 100, seg_dur, position_adjustment)
        logger.info("  Adjusted transcript time: %.1fs from start",
                    seconds_from_meeting_start + position_adjustment)
        logger.info("  Whisper video time: %.1fs", whisper_video_time)
        if match.get('cluster_median'):
            individual = whisper_video_time - (seconds_from_meeting_start + position_adjustment)
            logger.info("  ")
            logger.info("  Best match offset: %.1fs", individual)
            logger.info("  Cluster median offset: %.1fs (used — averages out interpolation error)", offset)
        else:
            logger.info("  ")
            logger.info("  Offset = whisper_time - adjusted_transcript_time")
            logger.info("  Offset = %.1fs - %.1fs = %.1fs",
                        whisper_video_time,
                        seconds_from_meeting_start + position_adjustment,
                        offset)
    else:
        logger.info("  Whisper video time: %.1fs", whisper_video_time)
        logger.info("  ")
        logger.info("  Offset = whisper_time - transcript_time")
        logger.info("  Offset = %.1fs - %.1fs = %.1fs",
                    whisper_video_time, seconds_from_meeting_start, offset)
    logger.info("\n✅ OFFSET: %.1f seconds (%d:%02d)", offset, int(offset // 60), int(offset % 60))
    logger.info("=" * 70)
    
    return offset


def main():
    if len(sys.argv) < 2:
        print("Usage: python match_whisper_to_transcript.py <video_id_or_whisper_json> <transcript_json> [options]")
        print("\nOptions:")
        print("  --model <name>         Whisper model (tiny/base/small/medium, default: small)")
        print("  --no-cache             Don't use or save cached Whisper JSON")
        print("  --video-mapping <file> Video mapping JSON for smart duration and auto-save")
        print("  --no-save              Don't write offset back to video mapping file")
        print("\nExamples:")
        print("  python match_whisper_to_transcript.py z40gz2O-FHw data/processed/transcript_2640_*.json")
        print("  python match_whisper_to_transcript.py z40gz2O-FHw transcript.json --video-mapping data/video_mapping_2645.json")
        sys.exit(1)
    
    input_arg = sys.argv[1]
    transcript_file = sys.argv[2]
    model = 'small'  # Default to small for better proper noun accuracy
    use_cache = True
    video_mapping_file = None
    auto_save = True  # Save offset to video mapping by default
    detect_gaps = False
    min_gap_minutes = 60
    
    # Parse options
    i = 3
    while i < len(sys.argv):
        if sys.argv[i] == '--model' and i + 1 < len(sys.argv):
            model = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--no-cache':
            use_cache = False
            i += 1
        elif sys.argv[i] == '--no-save':
            auto_save = False
            i += 1
        elif sys.argv[i] == '--video-mapping' and i + 1 < len(sys.argv):
            video_mapping_file = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--detect-gaps':
            detect_gaps = True
            i += 1
        elif sys.argv[i] == '--min-gap' and i + 1 < len(sys.argv):
            min_gap_minutes = int(sys.argv[i + 1])
            i += 2
        else:
            i += 1
    
    # Determine video_id from input
    video_id = None
    if input_arg.endswith('.json') and Path(input_arg).exists():
        whisper_file = input_arg
        print(f"Using existing Whisper transcription: {whisper_file}")
        # Try to extract video_id from cached filename (e.g., "SocxtU6vTKc_small_10min.json")
        stem = Path(input_arg).stem
        parts = stem.split('_')
        if parts:
            video_id = parts[0]
    else:
        # It's a video ID - need to transcribe
        video_id = input_arg
        
        # Calculate smart audio window if video mapping provided
        if video_mapping_file and Path(video_mapping_file).exists():
            window = calculate_smart_duration(video_mapping_file, transcript_file, video_id)
            audio_start = window.start
            duration = window.duration
        else:
            audio_start = 0
            duration = 300  # Default 5 minutes
        
        # Build cache filename — include start offset when skipping
        if audio_start > 0:
            cache_label = f"skip{audio_start}s_{duration}s"
        elif duration != 300:
            cache_label = f"{duration // 60}min"
        else:
            cache_label = ""
        cache_file = f"data/whisper_cache/{video_id}_{model}{f'_{cache_label}' if cache_label else ''}.json"
        
        # Check for cached transcription
        if use_cache and Path(cache_file).exists():
            print(f"✓ Found cached Whisper transcription: {cache_file}")
            whisper_file = cache_file
        else:
            # Transcribe with Whisper
            print(f"\n{'='*70}")
            print(f"TRANSCRIBING VIDEO WITH WHISPER")
            print(f"{'='*70}")
            print(f"Video ID: {video_id}")
            print(f"Model: {model}")
            if audio_start > 0:
                print(f"Start: {audio_start}s ({audio_start//60}:{audio_start%60:02d} into video)")
            print(f"Duration: {duration}s ({duration//60} minutes)")
            print()
            
            # Create cache directory
            Path("data/whisper_cache").mkdir(exist_ok=True)
            
            # Run transcription
            cmd = [
                sys.executable, 'scripts/build/transcribe_with_whisper.py',
                video_id,
                '--duration', str(duration),
                '--model', model,
                '--output', cache_file
            ]
            if audio_start > 0:
                cmd.extend(['--start', str(audio_start)])

            result = subprocess.run(cmd)
            
            if result.returncode != 0:
                print("\n❌ Transcription failed")
                sys.exit(1)
            
            whisper_file = cache_file
    
    # Try to match
    print(f"\n{'='*70}")
    print(f"MATCHING WHISPER TO OFFICIAL TRANSCRIPT")
    print(f"{'='*70}\n")
    
    # For Part 2+ videos, look up transcript_start_time from video mapping
    transcript_start_time = None
    if video_mapping_file and video_id:
        try:
            with open(video_mapping_file, 'r') as f:
                mapping = json.load(f)
            for video in mapping.get('videos', []):
                if video.get('video_id') == video_id:
                    transcript_start_time = video.get('transcript_start_time')
                    break
        except (json.JSONDecodeError, IOError):
            pass

    offset = calculate_offset(whisper_file, transcript_file,
                              transcript_start_time=transcript_start_time)
    
    # If no good match and we didn't use smart duration, try 10 minutes
    if offset is None and not input_arg.endswith('.json') and not video_mapping_file:
        print(f"\n{'='*70}")
        print(f"NO MATCH FOUND - RETRYING WITH 10 MINUTES")
        print(f"{'='*70}\n")
        
        video_id = input_arg
        longer_cache = f"data/whisper_cache/{video_id}_{model}_10min.json"
        
        # Transcribe 10 minutes
        result = subprocess.run([
            sys.executable, 'scripts/build/transcribe_with_whisper.py',
            video_id,
            '--duration', '600',
            '--model', model,
            '--output', longer_cache
        ])
        
        if result.returncode == 0:
            offset = calculate_offset(longer_cache, transcript_file,
                                      transcript_start_time=transcript_start_time)

    # For mapped videos (especially Part 2+), a chapter marker can still land inside
    # countdown music / slate. If initial match fails, sweep later windows.
    if offset is None and not input_arg.endswith('.json') and video_mapping_file and video_id:
        print(f"\n{'='*70}")
        print("NO MATCH FOUND - RETRYING WITH LATER WINDOWS")
        print(f"{'='*70}\n")

        # 2-minute step, up to +8 minutes from the original start.
        # This handles meetings where speech begins later than chapter[1].
        RETRY_OFFSETS = [120, 240, 360, 480]

        retry_duration = max(duration, 420)  # 7 min minimum for retries
        for delta in RETRY_OFFSETS:
            retry_start = audio_start + delta
            retry_label = f"retry_skip{retry_start}s_{retry_duration}s"
            retry_cache = f"data/whisper_cache/{video_id}_{model}_{retry_label}.json"

            print(f"  ▶ Retry window: start={retry_start}s ({retry_start//60}:{retry_start%60:02d}), "
                  f"duration={retry_duration}s ({retry_duration//60}:{retry_duration%60:02d})")

            if not (use_cache and Path(retry_cache).exists()):
                result = subprocess.run([
                    sys.executable, 'scripts/build/transcribe_with_whisper.py',
                    video_id,
                    '--start', str(retry_start),
                    '--duration', str(retry_duration),
                    '--model', model,
                    '--output', retry_cache
                ])
                if result.returncode != 0:
                    print("    ⚠️ Retry transcription failed, trying next window")
                    continue
            else:
                print(f"    ✓ Using cached retry transcription: {retry_cache}")

            offset = calculate_offset(retry_cache, transcript_file,
                                      transcript_start_time=transcript_start_time)
            if offset is not None:
                print(f"\n  ✅ Match succeeded on retry window (+{delta}s)")
                break
    
    if offset is not None:
        print(f"\nAdd to video_mapping JSON: \"offset_seconds\": {int(round(offset))}")
        
        # Auto-save offset to video mapping file
        if auto_save and video_mapping_file and video_id:
            save_offset_to_mapping(video_mapping_file, video_id, offset)
        elif auto_save and not video_mapping_file:
            print("  ℹ️  Pass --video-mapping <file> to auto-save offset")

        # Gap detection — find multi-part video boundaries
        if detect_gaps and video_mapping_file:
            # Standalone runs execute from the processor dir but don't have it
            # on sys.path (process_video normally handles that)
            sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
            from src.transcript_gap_detector import detect_gaps as find_gaps, save_gaps_to_mapping
            print(f"\n{'='*70}")
            print(f"DETECTING TRANSCRIPT GAPS")
            print(f"{'='*70}\n")
            gap_result = find_gaps(transcript_file, min_gap_minutes)
            if gap_result.gaps:
                print(f"  Found {len(gap_result.gaps)} gap(s):")
                for g in gap_result.gaps:
                    print(f"    {g.end_timestamp} → {g.resume_timestamp} ({g.gap_minutes} min)")
                if auto_save:
                    print()
                    save_gaps_to_mapping(video_mapping_file, gap_result.gaps)
            else:
                print(f"  No gaps ≥ {min_gap_minutes} min — single-part meeting")
    else:
        print("\n❌ Could not calculate offset even with extended transcription")


if __name__ == '__main__':
    main()

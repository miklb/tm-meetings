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
import sys
import subprocess
import re
from collections import namedtuple
from pathlib import Path
from datetime import datetime


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
        print(f"  ⚠️  Video mapping file not found: {video_mapping_file}")
        return False

    try:
        with open(path, 'r') as f:
            mapping = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"  ⚠️  Could not read video mapping: {e}")
        return False

    # Find and update the matching video entry
    updated = False
    for video in mapping.get('videos', []):
        if video.get('video_id') == video_id:
            video['offset_seconds'] = int(round(offset))
            updated = True
            break

    if not updated:
        print(f"  ⚠️  Video ID '{video_id}' not found in {path.name}")
        return False

    # Write back
    with open(path, 'w') as f:
        json.dump(mapping, f, indent=2)

    print(f"  ✅ Saved offset_seconds={int(round(offset))} to {path.name} for video {video_id}")
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
        estimated_speech_time = PRE_ROLL + speech_delay
        If estimated_speech_time > DEFAULT_DURATION (10 min):
            start  = estimated_speech_time − SKIP_MARGIN
            duration = SKIP_MARGIN + MATCH_BUFFER   (8 min clip around speech)
        Otherwise:
            start  = 0
            duration = max(DEFAULT_DURATION, estimated_speech_time + MATCH_BUFFER)

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
    PART2_NO_CHAPTERS_DURATION = 900      # 15-min fallback for Part 2+
    CHAPTER_BUFFER = 120                  # 2-min buffer past first content chapter
    PRE_ROLL = 300                        # 5 min — video starts before scheduled time
    MATCH_BUFFER = 180                    # 3 min — enough speech for Whisper matching
    SKIP_MARGIN = 300                     # 5 min — margin before expected speech when skipping

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
            print(f"  ⚠️  Video '{video_id}' not found in mapping — using defaults")
    except (json.JSONDecodeError, IOError) as e:
        print(f"  ⚠️  Could not read video mapping for smart duration: {e}")

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

                # If chapters exist, use the first content chapter as a floor
                # (e.g., "Item 1" at 690s tells us speech is at least that far)
                if len(chapters) > 1:
                    first_chapter_secs = chapters[1].get('seconds', 0)
                    if first_chapter_secs > estimated_speech:
                        estimated_speech = first_chapter_secs

                if estimated_speech > DEFAULT_DURATION:
                    # Speech is far enough in to benefit from skipping b-roll
                    start = estimated_speech - SKIP_MARGIN
                    duration = SKIP_MARGIN + MATCH_BUFFER
                    delay_min = speech_delay / 60
                    reason = (f"Part 1 {session_label} — skip to {start}s, "
                              f"first speech ~{delay_min:.0f}m after schedule "
                              f"(est. {estimated_speech}s into video)")
                else:
                    start = 0
                    duration = max(DEFAULT_DURATION,
                                   estimated_speech + MATCH_BUFFER)
                    delay_min = speech_delay / 60
                    reason = (f"Part 1 {session_label} — first speech "
                              f"{delay_min:.0f}m after schedule + "
                              f"{PRE_ROLL // 60}m pre-roll + "
                              f"{MATCH_BUFFER // 60}m match buffer")
                    if duration == DEFAULT_DURATION:
                        reason += f" (clamped to {DEFAULT_DURATION}s minimum)"
            else:
                duration = DEFAULT_DURATION
                reason = "Part 1 — non-standard meeting time, using default"
        else:
            duration = DEFAULT_DURATION
            reason = "Part 1 — no transcript timestamp, using default"

    elif len(chapters) > 1:
        # Part 2+: use first real content chapter (index 1, since index 0 is
        # typically the "Start of Meeting" placeholder at 0:00)
        first_content_secs = chapters[1].get('seconds', 0)
        if first_content_secs > DEFAULT_DURATION:
            duration = first_content_secs + CHAPTER_BUFFER
            reason = (f"Part {part} — first content chapter at "
                      f"{first_content_secs}s + {CHAPTER_BUFFER}s buffer")
        else:
            duration = DEFAULT_DURATION
            reason = (f"Part {part} — first content chapter at "
                      f"{first_content_secs}s fits within {DEFAULT_DURATION}s default")
    else:
        duration = PART2_NO_CHAPTERS_DURATION
        reason = f"Part {part} — no chapter data, conservative {PART2_NO_CHAPTERS_DURATION}s"

    if start > 0:
        print(f"  📐 Smart duration: skip to {start}s ({start // 60}:{start % 60:02d}), "
              f"capture {duration}s ({duration // 60}:{duration % 60:02d}) — {reason}")
    else:
        end = start + duration
        print(f"  📐 Smart duration: {duration}s ({duration // 60}:{duration % 60:02d}) — {reason}")
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
    print("\nSearching for speech match...")

    MIN_SCORE = 0.3        # At least 30% of n-grams must match
    OFFSET_TOLERANCE = 30  # Seconds — matches within this range cluster together

    # Collect ALL candidate Whisper segments with meaningful text
    candidates = []
    for w_seg in whisper_segments:
        if w_seg.get('no_speech_prob', 0) > 0.3:
            continue

        w_text = w_seg['text'].strip()

        # Must be mostly ASCII
        ascii_chars = sum(1 for c in w_text if ord(c) < 128)
        if len(w_text) > 0 and ascii_chars / len(w_text) < 0.85:
            continue

        content_words = extract_content_words(w_text)

        # Need at least 4 content words (stop words removed)
        if len(content_words) >= 4:
            candidates.append({
                'text': w_text,
                'start': w_seg['start'],
                'content_words': content_words,
            })

    if not candidates:
        print("ERROR: No meaningful speech found in Whisper output")
        return None

    print(f"  Found {len(candidates)} candidate Whisper segments to try")

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
                # Find WHERE in the official segment the match appears
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
        print(f"\nERROR: Could not find Whisper text in official transcript "
              f"(tried {len(candidates)} candidates, min score {MIN_SCORE})")
        return None

    print(f"  {len(all_matches)} matches above threshold")

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
        print(f"\n  Offset clusters: {len(clusters)}")
        for i, cl in enumerate(clusters[:4]):
            offsets = [m['implied_offset'] for m in cl]
            median_off = sorted(offsets)[len(offsets) // 2]
            print(f"    Cluster {i+1}: offset ~{median_off:.0f}s, "
                  f"{unique_candidates(cl)} unique candidates, "
                  f"{len(cl)} total matches, "
                  f"best score {max(m['score'] for m in cl):.2f}")

        # Within the winning cluster, pick match with highest score
        best_cluster.sort(key=lambda m: m['score'], reverse=True)
        best = best_cluster[0]

        print(f"\n✓ MATCHED Whisper candidate {best['candidate_idx']} at {best['whisper_start']:.1f}s "
              f"to official segment {best['official_index']} "
              f"at {best['official_timestamp']} (score: {best['score']:.2f}, "
              f"offset: {best['implied_offset']:.0f}s, "
              f"cluster support: {unique_candidates(best_cluster)} candidates)")
    else:
        # Only one match or no baseline — just pick highest score
        all_matches.sort(key=lambda m: m['score'], reverse=True)
        best = all_matches[0]

        print(f"\n✓ MATCHED Whisper candidate {best['candidate_idx']} at {best['whisper_start']:.1f}s "
              f"to official segment {best['official_index']} "
              f"at {best['official_timestamp']} (score: {best['score']:.2f})")

    print(f"  Whisper:  \"{best['whisper_text'][:80]}\"")
    print(f"  Official: \"{best['official_text'][:80]}\"")

    # Log runner-up if from a different cluster
    if len(clusters) > 1:
        runner_cluster = clusters[1]
        runner = max(runner_cluster, key=lambda m: m['score'])
        print(f"  Runner-up cluster: candidate {runner['candidate_idx']} at "
              f"{runner['whisper_start']:.1f}s → segment {runner['official_index']} "
              f"at {runner['official_timestamp']} (score: {runner['score']:.2f}, "
              f"offset: {runner['implied_offset']:.0f}s, "
              f"{unique_candidates(runner_cluster)} candidates)")

    return best


def calculate_offset(whisper_json_file, official_transcript_file):
    """
    Calculate video offset.
    
    Returns:
        offset in seconds, or None if can't calculate
    """
    # Load Whisper output
    with open(whisper_json_file) as f:
        whisper_data = json.load(f)
    
    whisper_segments = whisper_data['segments']
    print(f"✓ Loaded Whisper output: {len(whisper_segments)} segments")
    
    # Load official transcript
    with open(official_transcript_file) as f:
        official_data = json.load(f)
    
    official_segments = official_data['segments']
    print(f"✓ Loaded official transcript: {len(official_segments)} segments")
    
    # Get first official timestamp as baseline
    first_timestamp = official_segments[0].get('timestamp')
    if not first_timestamp:
        print("❌ First official segment has no timestamp")
        return None
    
    first_seconds = parse_timestamp_to_seconds(first_timestamp)
    print(f"  First official timestamp: {first_timestamp} (baseline)")
    
    # Find match (pass baseline for cross-validation)
    match = find_best_match(whisper_segments, official_segments,
                            first_seconds=first_seconds)
    
    if not match:
        print("\n❌ No good match found")
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
    
    print(f"\n" + "="*70)
    print(f"✅ MATCH FOUND")
    print(f"="*70)
    print(f"Whisper first speech at {whisper_video_time:.1f}s:")
    print(f"  \"{match['whisper_text'][:80]}...\"")
    print(f"\nFound in official segment {match['official_index']} at {match['official_timestamp']}:")
    print(f"  \"{match['official_text'][:80]}...\"")
    print(f"\nOffset Calculation:")
    print(f"  Meeting baseline: {first_timestamp} (0 seconds)")
    print(f"  Official segment: {match['official_timestamp']} ({seconds_from_meeting_start}s from start)")
    if position_adjustment > 1:
        print(f"  Position within segment: {position_frac:.0%} of {seg_dur:.0f}s = +{position_adjustment:.1f}s")
        print(f"  Adjusted transcript time: {seconds_from_meeting_start + position_adjustment:.1f}s from start")
    print(f"  Whisper video time: {whisper_video_time:.1f}s")
    print(f"  ")
    print(f"  Offset = whisper_time - adjusted_transcript_time")
    print(f"  Offset = {whisper_video_time:.1f}s - {seconds_from_meeting_start + position_adjustment:.1f}s = {offset:.1f}s")
    print(f"\n✅ OFFSET: {offset:.1f} seconds ({int(offset//60)}:{int(offset%60):02d})")
    print("="*70)
    
    return offset


def main():
    if len(sys.argv) < 2:
        print("Usage: python match_whisper_to_transcript.py <video_id_or_whisper_json> <transcript_json> [options]")
        print("\nOptions:")
        print("  --model <name>         Whisper model (tiny/base/small/medium, default: base)")
        print("  --no-cache             Don't use or save cached Whisper JSON")
        print("  --video-mapping <file> Video mapping JSON for smart duration and auto-save")
        print("  --no-save              Don't write offset back to video mapping file")
        print("\nExamples:")
        print("  python match_whisper_to_transcript.py z40gz2O-FHw data/processed/transcript_2640_*.json")
        print("  python match_whisper_to_transcript.py z40gz2O-FHw transcript.json --video-mapping data/video_mapping_2645.json")
        sys.exit(1)
    
    input_arg = sys.argv[1]
    transcript_file = sys.argv[2]
    model = 'base'  # Default to base for speed; n-gram matching compensates
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
    
    offset = calculate_offset(whisper_file, transcript_file)
    
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
            offset = calculate_offset(longer_cache, transcript_file)
    
    if offset is not None:
        print(f"\nAdd to video_mapping JSON: \"offset_seconds\": {int(round(offset))}")
        
        # Auto-save offset to video mapping file
        if auto_save and video_mapping_file and video_id:
            save_offset_to_mapping(video_mapping_file, video_id, offset)
        elif auto_save and not video_mapping_file:
            print("  ℹ️  Pass --video-mapping <file> to auto-save offset")

        # Gap detection — find multi-part video boundaries
        if detect_gaps and video_mapping_file:
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

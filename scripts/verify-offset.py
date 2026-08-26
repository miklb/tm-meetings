#!/usr/bin/env python3
"""
Empirically verify one video_mapping offset by downloading a short audio
window from YouTube, transcribing it with faster-whisper, and fuzzy-aligning
a candidate official-transcript segment against the whisper output.

Usage (pipeline venv):
    python3 scripts/verify-offset.py --tid <TID>                       # every part
    python3 scripts/verify-offset.py --tid <TID> --video-id=<ID>       # one video
    python3 scripts/verify-offset.py --tid <TID> --at 11:05:19AM       # measure at a time
    python3 scripts/verify-offset.py --tid <TID> --strict              # exit code for CI/pipeline gates

Prints one JSON line per part (human-readable summary to stderr).
Verdicts: OK (<=15s) / SUSPECT (<=60s) / WRONG / NO-MATCH / UNCHECKED.
Skips procedural boilerplate (roll calls, motions) when choosing anchors —
those phrases recur all meeting and fuzzy-match the wrong occurrence.
Read-only: never modifies any mapping/transcript files.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPPING_DIR = os.path.join(REPO_ROOT, 'transcript-cleaner', 'processor', 'data')
PROCESSED_DIR = os.path.join(MAPPING_DIR, 'processed')

NON_WORD_RE = re.compile(r'[^A-Z0-9 ]')
BRACKET_RE = re.compile(r'\[[^\]]*\]')

ANCHOR_WORDS = 12          # official words used as the anchor phrase
ANCHOR_MIN_RATIO = 0.55    # SequenceMatcher ratio floor to accept a match
CLIP_HALF_WINDOW = 90      # seconds either side of predicted position

# Some videos (auto-dub enabled) publish itags 234/233/140 once per
# language, so the bare itag is ambiguous/missing; prefer the English
# ('en' or 'en-US') track explicitly, then fall back to the bare itag
# for older videos that only ever had one audio track.
FORMATS = ['234[language^=en]/234', '233[language^=en]/233',
           'bestaudio[language^=en]/140']
# The pipeline venv pins an older yt-dlp (2026.08.17) that hangs
# indefinitely on some current videos; use the newer Homebrew yt-dlp
# for URL resolution instead of whatever 'yt-dlp' resolves to on PATH.
YT_DLP_BIN = '/opt/homebrew/bin/yt-dlp' if os.path.exists('/opt/homebrew/bin/yt-dlp') else 'yt-dlp'


def parse_iso_duration(duration_str):
    if not duration_str or not duration_str.startswith('PT'):
        return None
    s = duration_str[2:]
    hours = minutes = seconds = 0
    if 'H' in s:
        h, s = s.split('H')
        hours = int(h)
    if 'M' in s:
        m, s = s.split('M')
        minutes = int(m)
    if 'S' in s:
        seconds = int(s.replace('S', ''))
    return hours * 3600 + minutes * 60 + seconds


def parse_ts_to_seconds(ts):
    from datetime import datetime
    ts = ts.strip().upper()
    try:
        dt = datetime.strptime(ts, '%I:%M:%S%p')
    except ValueError:
        dt = datetime.strptime(ts, '%I:%M%p')
    return dt.hour * 3600 + dt.minute * 60 + dt.second


def normalize_words(text):
    text = BRACKET_RE.sub(' ', text.upper())
    text = NON_WORD_RE.sub(' ', text)
    return ' '.join(text.split()).split()


def load_mapping(tid):
    path = os.path.join(MAPPING_DIR, f'video_mapping_{tid}.json')
    with open(path) as f:
        return json.load(f)


def load_segments(tid):
    matches = glob.glob(os.path.join(PROCESSED_DIR, f'processed_transcript_{tid}_*.json'))
    if not matches:
        return None
    with open(matches[0]) as f:
        data = json.load(f)
    out = []
    for s in data.get('segments', []):
        ts = s.get('timestamp')
        text = s.get('text', '')
        if not ts or not text:
            continue
        try:
            secs = parse_ts_to_seconds(ts)
        except ValueError:
            continue
        out.append({'ts': ts, 'secs': secs, 'text': text, 'speaker': s.get('speaker', '')})
    return out


def part_context(mapping, segments, part_num):
    videos_sorted = sorted(mapping.get('videos', []), key=lambda v: v.get('part', 1))
    idx = next((i for i, v in enumerate(videos_sorted) if v.get('part', 1) == part_num), None)
    if idx is None:
        return None

    # A non-first part (index > 0) with no explicit transcript_start_time
    # has its baseline collapse to the transcript's first segment, which is
    # wrong for anything but the first part — it corrupts both that part's
    # own span AND the upper boundary of the part before it. The first part
    # lacking transcript_start_time is fine: the transcript's first segment
    # IS its true start.
    degenerate = [i > 0 and v.get('transcript_start_time') is None
                  for i, v in enumerate(videos_sorted)]
    if degenerate[idx] or (idx + 1 < len(degenerate) and degenerate[idx + 1]):
        return 'AMBIGUOUS'

    baselines = []
    for v in videos_sorted:
        tst = v.get('transcript_start_time')
        if tst:
            baselines.append(parse_ts_to_seconds(tst))
        else:
            baselines.append(segments[0]['secs'] if segments else None)
    baseline = baselines[idx]
    next_baseline = baselines[idx + 1] if idx + 1 < len(baselines) else None
    if baseline is None:
        part_segs = []
    else:
        part_segs = [s for s in segments
                     if s['secs'] >= baseline and (next_baseline is None or s['secs'] < next_baseline)]
    return baseline, part_segs, videos_sorted[idx]


# Procedural boilerplate recurs dozens of times per meeting (roll calls,
# motions, "all in favor"), so a 12-word anchor drawn from it can fuzzy-match
# the WRONG occurrence and report a phantom drift. Skip segments whose
# opening words are dominated by this language.
GENERIC_RE = re.compile(
    r'\b(motion|second(ed)?|all (those )?in favor|opposed|ayes? have it|roll call|'
    r'motion carries|so moved|please call the roll|item (number|no\.?) \d+|'
    r'good morning|good afternoon|welcome back|thank you(,)? (mr|ms|madam|council))\b',
    re.I)
MIN_UNIQUE_RATIO = 0.6     # distinct words / total words in the anchor phrase


def is_generic(seg):
    words = seg['text'].split()
    if len(words) < 25:
        return True
    head = ' '.join(words[:ANCHOR_WORDS + 4])
    if len(GENERIC_RE.findall(head)) >= 2:
        return True
    anchor = normalize_words(seg['text'])[:ANCHOR_WORDS]
    if anchor and len(set(anchor)) / len(anchor) < MIN_UNIQUE_RATIO:
        return True
    return False


def pick_candidate(part_segs, frac, exclude=None):
    exclude = exclude or set()
    if not part_segs:
        return None
    target = int(len(part_segs) * frac)
    target = min(max(target, 0), len(part_segs) - 1)
    order = sorted(range(len(part_segs)), key=lambda i: abs(i - target))
    for i in order:
        if i in exclude:
            continue
        seg = part_segs[i]
        if not is_generic(seg):
            return i, seg
    return None


def pick_at(part_segs, at_secs):
    """Nearest non-generic segment at/after a requested transcript time."""
    order = sorted(range(len(part_segs)), key=lambda i: abs(part_segs[i]['secs'] - at_secs))
    for i in order:
        if not is_generic(part_segs[i]):
            return i, part_segs[i]
    return None


def get_direct_url(video_id):
    for fmt in FORMATS:
        try:
            r = subprocess.run(
                [YT_DLP_BIN, '-q', '--no-warnings', '-g', '-f', fmt,
                 f'https://www.youtube.com/watch?v={video_id}'],
                capture_output=True, text=True, timeout=45)
        except subprocess.TimeoutExpired:
            continue
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().splitlines()[-1].strip(), fmt
    return None, None


def extract_clip(url, start, end, wav_path):
    start = max(0, start)
    end = max(start + 1, end)
    cmd = ['ffmpeg', '-y', '-v', 'error', '-ss', str(start), '-to', str(end),
           '-i', url, '-vn', '-ar', '16000', '-ac', '1', wav_path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0 and os.path.exists(wav_path) and os.path.getsize(wav_path) > 1000


_MODEL = None


def get_model():
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel
        _MODEL = WhisperModel("base", compute_type="int8")
    return _MODEL


def transcribe(wav_path):
    model = get_model()
    segments, _ = model.transcribe(wav_path, beam_size=1, word_timestamps=True, vad_filter=True)
    word_stream = []  # (WORD, clip_relative_seconds)
    for seg in segments:
        for w in (seg.words or []):
            for tok in normalize_words(w.word):
                word_stream.append((tok, w.start))
    return word_stream


def best_anchor(word_stream, official_words):
    n = min(ANCHOR_WORDS, len(official_words))
    if n < 5 or len(word_stream) < n:
        return None
    target = official_words[:n]
    word_list = [w for w, _ in word_stream]
    best_ratio, best_idx = 0.0, None
    for i in range(len(word_list) - n + 1):
        ratio = SequenceMatcher(None, target, word_list[i:i + n]).ratio()
        if ratio > best_ratio:
            best_ratio, best_idx = ratio, i
    if best_idx is None or best_ratio < ANCHOR_MIN_RATIO:
        return None
    return best_ratio, word_stream[best_idx][1]


def verdict_for(drift):
    if drift is None:
        return 'NO-MATCH'
    ad = abs(drift)
    if ad <= 15:
        return 'OK'
    if ad <= 60:
        return 'SUSPECT'
    return 'WRONG'


def run_candidate(mapping_video, baseline, seg, clip_dir, keep_wav, url):
    seg_secs = seg['secs']
    predicted = mapping_video['offset_seconds'] + (seg_secs - baseline)
    duration_secs = parse_iso_duration(mapping_video.get('duration')) or (predicted + 3600)
    clip_start_abs = max(0, predicted - CLIP_HALF_WINDOW)
    clip_end_abs = min(duration_secs, predicted + CLIP_HALF_WINDOW)

    wav_path = os.path.join(clip_dir, f"clip_{mapping_video['video_id']}_{seg['ts'].replace(':', '')}.wav")
    if not extract_clip(url, clip_start_abs, clip_end_abs, wav_path):
        return {'ok': False, 'reason': 'ffmpeg extraction failed', 'predicted': predicted}

    try:
        word_stream = transcribe(wav_path)
    finally:
        if not keep_wav and os.path.exists(wav_path):
            os.remove(wav_path)

    official_words = normalize_words(seg['text'])
    anchor = best_anchor(word_stream, official_words)
    if anchor is None:
        return {'ok': False, 'reason': 'no fuzzy match in whisper output',
                'predicted': predicted, 'whisper_words': len(word_stream)}

    ratio, clip_rel_secs = anchor
    observed = clip_start_abs + clip_rel_secs
    drift = observed - predicted
    return {'ok': True, 'predicted': predicted, 'observed': observed, 'drift': drift,
            'confidence': ratio, 'verdict': verdict_for(drift),
            'segment_ts': seg['ts'], 'segment_speaker': seg['speaker'],
            'segment_text': seg['text'][:120]}


def verify_part(mapping, segments, video, keep_wav=False, at=None):
    """Verify one video part. Returns a result dict (always has ok/verdict)."""
    part_num = video.get('part', 1)
    base = {'tid': mapping.get('meeting_id'), 'video_id': video.get('video_id'), 'part': part_num}

    def fail(reason, **extra):
        return {**base, 'ok': False, 'verdict': 'UNCHECKED', 'reason': reason, **extra}

    if not segments:
        return fail('no usable transcript segments')
    ctx = part_context(mapping, segments, part_num)
    if ctx is None:
        return fail('part not found in mapping')
    if ctx == 'AMBIGUOUS':
        return fail('ambiguous part boundary: multi-part file with transcript_start_time '
                    'missing on this/a sibling part; cannot reliably assign segments')
    baseline, part_segs, _ = ctx
    if not part_segs:
        return fail('no segments assigned to this part')
    if video.get('offset_seconds') is None:
        return fail('no offset_seconds set on this part (offset never computed)')

    url, fmt = get_direct_url(video['video_id'])
    if not url:
        return fail('yt-dlp: no playable stream (video unavailable)')

    with tempfile.TemporaryDirectory() as clip_dir:
        tried = set()
        result = None
        if at is not None:
            plan = [('at', at)]
        else:
            plan = [('frac', f) for f in (0.5, 0.25, 0.7)]
        for kind, val in plan:
            cand = pick_at(part_segs, val) if kind == 'at' else pick_candidate(part_segs, val, exclude=tried)
            if cand is None:
                continue
            idx, seg = cand
            tried.add(idx)
            result = run_candidate(video, baseline, seg, clip_dir, keep_wav, url)
            if result.get('ok'):
                break
        if result is None:
            return fail('no non-generic candidate segment with >=25 words found')
    if not result.get('ok'):
        result.setdefault('verdict', 'NO-MATCH')
    return {**base, **result}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tid', type=int, required=True)
    ap.add_argument('--video-id', dest='video_id', default=None,
                    help='verify only this video (default: every part in the mapping)')
    ap.add_argument('--part', type=int, default=None)
    ap.add_argument('--at', default=None,
                    help='transcript timestamp (e.g. 11:05:19AM) to measure at, instead of auto-picking')
    ap.add_argument('--keep-wav', action='store_true')
    ap.add_argument('--strict', action='store_true',
                    help='exit 1 if any part is WRONG/NO-MATCH, exit 2 if any is SUSPECT/UNCHECKED')
    args = ap.parse_args()

    mapping = load_mapping(args.tid)
    mapping.setdefault('meeting_id', args.tid)
    videos = [v for v in sorted(mapping.get('videos', []), key=lambda v: v.get('part', 1))
              if (args.video_id is None or v.get('video_id') == args.video_id)
              and (args.part is None or v.get('part') == args.part)]
    if not videos:
        print(json.dumps({'ok': False, 'tid': args.tid, 'video_id': args.video_id,
                           'verdict': 'UNCHECKED', 'reason': 'video entry not found in mapping'}))
        sys.exit(2 if args.strict else 0)

    segments = load_segments(args.tid)
    at_secs = parse_ts_to_seconds(args.at) if args.at else None
    worst = 0
    for video in videos:
        result = verify_part(mapping, segments, video, keep_wav=args.keep_wav, at=at_secs)
        print(json.dumps(result), flush=True)
        v = result.get('verdict')
        if v in ('WRONG', 'NO-MATCH'):
            worst = max(worst, 2)
        elif v in ('SUSPECT', 'UNCHECKED'):
            worst = max(worst, 1)
        drift = result.get('drift')
        summary = (f"{result['video_id']} part {result['part']}: {v}"
                   + (f" (drift {drift:+.1f}s, conf {result.get('confidence', 0):.2f})" if drift is not None
                      else f" ({result.get('reason', '')})"))
        print(summary, file=sys.stderr)
    if args.strict:
        sys.exit({0: 0, 1: 2, 2: 1}[worst])


if __name__ == '__main__':
    main()

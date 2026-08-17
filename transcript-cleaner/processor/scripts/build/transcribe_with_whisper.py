#!/usr/bin/env python3
"""
Transcribe YouTube video with Whisper and save output.

This script ONLY does transcription - no matching, no offset calculation.
Just downloads audio, transcribes it, and saves the result.
"""

import logging
from faster_whisper import WhisperModel
import sys
import json
import shutil
import subprocess
import tempfile
import time
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def _find_ytdlp() -> str:
    """Resolve yt-dlp, checking the venv bin directory as a fallback."""
    found = shutil.which("yt-dlp")
    if found:
        return found
    # Check next to the running Python executable (venv bin)
    venv_candidate = Path(sys.executable).parent / "yt-dlp"
    if venv_candidate.exists():
        return str(venv_candidate)
    raise FileNotFoundError(
        "yt-dlp not found on PATH or in the venv bin directory. "
        "Install with: venv/bin/pip install yt-dlp"
    )


def download_audio_sample(video_id, duration=300, start=0):
    """Download N seconds of YouTube video audio starting at a given offset.

    Uses yt-dlp's --download-sections to only fetch the relevant portion
    of the video, avoiding a full 3-hour download for a 5-minute clip.
    """
    audio_path = tempfile.mktemp(suffix='.mp3')
    url = f"https://www.youtube.com/watch?v={video_id}"

    end = start + duration
    ytdlp = _find_ytdlp()
    cmd = [
        ytdlp,
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '5',
        '--download-sections', f'*{start}-{end}',
    ]
    if start > 0:
        # Without this, yt-dlp cuts at the nearest keyframe BEFORE the
        # requested start, so the extracted audio leads the requested time by
        # up to ~10s and every shifted timestamp inherits that error.
        cmd.append('--force-keyframes-at-cuts')
    cmd += ['-o', audio_path, url]

    # YouTube 403s the client yt-dlp falls back to on an intermittent,
    # per-URL basis; a fresh attempt re-resolves the download URL and
    # usually lands (observed 2026-08-17: same command failing and
    # succeeding minutes apart).
    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            return audio_path
        except subprocess.CalledProcessError as e:
            stderr_tail = '\n'.join(
                e.stderr.decode(errors='replace').strip().splitlines()[-4:]
            )
            if attempt == attempts:
                print(f"yt-dlp failed after {attempts} attempts; last stderr:\n{stderr_tail}")
                raise
            print(f"yt-dlp attempt {attempt}/{attempts} failed (retrying in 30s):\n{stderr_tail}")
            time.sleep(30)


def transcribe_video(video_id, duration=300, model_name='base', start=0):
    """
    Transcribe video with Whisper.
    
    Args:
        video_id: YouTube video ID
        duration: Seconds of audio to transcribe
        model_name: Whisper model name
        start: Seconds into the video to start extracting audio.
               When > 0, segment timestamps are shifted so they represent
               absolute video time (not time-since-extraction-start).
    
    Returns list of segments with:
    - start: seconds from video start (absolute); snapped to the first
      word's aligned timestamp when word timestamps are available
    - end: seconds from video start (absolute)
    - text: transcribed text
    - no_speech_prob: probability the segment is not speech
    - words: per-word {start, end, word} timing (when available)
    """
    if start > 0:
        logger.info("Downloading %ds of audio from %s (starting at %ds / %d:%02d)...",
                    duration, video_id, start, start // 60, start % 60)
    else:
        logger.info("Downloading first %ds of audio from %s...", duration, video_id)
    audio_path = download_audio_sample(video_id, duration, start)

    logger.info("Loading faster-whisper model '%s' (cpu/int8)...", model_name)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    logger.info("Transcribing %s...", audio_path)
    seg_iter, _info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
    )

    segments = []
    for seg in seg_iter:
        entry = {
            'start': seg.start,
            'end': seg.end,
            'text': seg.text,
            'no_speech_prob': seg.no_speech_prob,
        }
        if seg.words:
            # Word timestamps come from acoustic alignment and are far more
            # precise than segment boundaries, which drift after music/silence.
            entry['start'] = seg.words[0].start
            entry['end'] = seg.words[-1].end
            entry['words'] = [
                {'start': w.start, 'end': w.end, 'word': w.word}
                for w in seg.words
            ]
        segments.append(entry)

    # Clean up
    os.remove(audio_path)

    # Shift timestamps to absolute video time when audio was extracted
    # from a non-zero start point
    if start > 0:
        for seg in segments:
            seg['start'] += start
            seg['end'] += start
            for w in seg.get('words', []):
                w['start'] += start
                w['end'] += start
        logger.info("  Shifted %d segment timestamps by +%ds", len(segments), start)

    return segments


def main():
    import argparse
    # Import here to avoid circular imports when used as a library
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
    from src.logging_config import setup_logging

    parser = argparse.ArgumentParser(
        description="Transcribe a YouTube video with Whisper and save JSON output."
    )
    parser.add_argument("video_id", help="YouTube video ID")
    parser.add_argument("--duration", type=int, default=300,
                        help="Sample duration in seconds (default: 300)")
    parser.add_argument("--start", type=int, default=0,
                        help="Start offset in video seconds (default: 0)")
    parser.add_argument("--model", default="base",
                        help="Whisper model: tiny/base/small/medium (default: base)")
    parser.add_argument("--output", default=None,
                        help="Output JSON file (default: whisper_<video_id>.json)")
    parser.add_argument("--log-date", default=None,
                        help="Meeting date YYYY-MM-DD — routes logs to that meeting's log file")
    args = parser.parse_args()

    setup_logging(args.log_date)

    video_id = args.video_id
    duration = args.duration
    start = args.start
    model_name = args.model
    output_file = args.output or f"whisper_{video_id}.json"

    # Transcribe
    segments = transcribe_video(video_id, duration, model_name, start)

    # Save to JSON
    output_data = {
        'video_id': video_id,
        'audio_start': start,
        'duration': duration,
        'model': model_name,
        'segments': segments
    }

    with open(output_file, 'w') as f:
        json.dump(output_data, f, indent=2)

    logger.info("\n✓ Saved %d segments to %s", len(segments), output_file)

    # Log full transcription at DEBUG so it appears in the log file but not console
    logger.debug("\nTranscription:")
    for seg in segments:
        start_min = int(seg['start'] // 60)
        start_sec = int(seg['start'] % 60)
        logger.debug("  [%d:%02d] %s", start_min, start_sec, seg['text'])


if __name__ == '__main__':
    main()

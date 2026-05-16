#!/usr/bin/env python3
"""
Transcribe YouTube video with Whisper and save output.

This script ONLY does transcription - no matching, no offset calculation.
Just downloads audio, transcribes it, and saves the result.
"""

import logging
import whisper
import sys
import json
import shutil
import subprocess
import tempfile
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
        '-o', audio_path,
        url
    ]

    subprocess.run(cmd, check=True, capture_output=True)
    return audio_path


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
    - start: seconds from video start (absolute)
    - end: seconds from video start (absolute)
    - text: transcribed text
    """
    if start > 0:
        logger.info("Downloading %ds of audio from %s (starting at %ds / %d:%02d)...",
                    duration, video_id, start, start // 60, start % 60)
    else:
        logger.info("Downloading first %ds of audio from %s...", duration, video_id)
    audio_path = download_audio_sample(video_id, duration, start)

    logger.info("Loading Whisper model '%s'...", model_name)
    model = whisper.load_model(model_name)

    logger.info("Transcribing %s...", audio_path)
    result = model.transcribe(audio_path, word_timestamps=False)

    # Clean up
    os.remove(audio_path)

    # Shift timestamps to absolute video time when audio was extracted
    # from a non-zero start point
    segments = result['segments']
    if start > 0:
        for seg in segments:
            seg['start'] += start
            seg['end'] += start
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

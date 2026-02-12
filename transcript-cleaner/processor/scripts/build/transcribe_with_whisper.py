#!/usr/bin/env python3
"""
Transcribe YouTube video with Whisper and save output.

This script ONLY does transcription - no matching, no offset calculation.
Just downloads audio, transcribes it, and saves the result.
"""

import whisper
import sys
import json
import subprocess
import tempfile
import os


def download_audio_sample(video_id, duration=300, start=0):
    """Download N seconds of YouTube video audio starting at a given offset.

    Uses yt-dlp's --download-sections to only fetch the relevant portion
    of the video, avoiding a full 3-hour download for a 5-minute clip.
    """
    audio_path = tempfile.mktemp(suffix='.mp3')
    url = f"https://www.youtube.com/watch?v={video_id}"

    end = start + duration
    cmd = [
        'yt-dlp',
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
        print(f"Downloading {duration}s of audio from {video_id} (starting at {start}s / {start//60}:{start%60:02d})...")
    else:
        print(f"Downloading first {duration}s of audio from {video_id}...")
    audio_path = download_audio_sample(video_id, duration, start)
    
    print(f"Loading Whisper model '{model_name}'...")
    model = whisper.load_model(model_name)
    
    print(f"Transcribing {audio_path}...")
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
        print(f"  Shifted {len(segments)} segment timestamps by +{start}s")
    
    return segments


def main():
    if len(sys.argv) < 2:
        print("Usage: python transcribe_with_whisper.py <video_id> [options]")
        print("\nOptions:")
        print("  --duration <secs>   Sample duration (default: 300)")
        print("  --start <secs>      Start offset in video (default: 0)")
        print("  --model <name>      Whisper model (tiny/base/small, default: base)")
        print("  --output <file>     Output JSON file (default: whisper_<video_id>.json)")
        print("\nExample:")
        print("  python transcribe_with_whisper.py JhLSLEN6AUc --duration 360 --output whisper_2435.json")
        print("  python transcribe_with_whisper.py JhLSLEN6AUc --start 1130 --duration 300  # skip b-roll")
        sys.exit(1)
    
    video_id = sys.argv[1]
    duration = 300
    start = 0
    model_name = 'base'
    output_file = f"whisper_{video_id}.json"
    
    # Parse arguments
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == '--duration' and i + 1 < len(sys.argv):
            duration = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == '--start' and i + 1 < len(sys.argv):
            start = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == '--model' and i + 1 < len(sys.argv):
            model_name = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--output' and i + 1 < len(sys.argv):
            output_file = sys.argv[i + 1]
            i += 2
        else:
            i += 1
    
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
    
    print(f"\n✓ Saved {len(segments)} segments to {output_file}")
    
    # Also print human-readable version
    print("\nTranscription:")
    for seg in segments:
        start_min = int(seg['start'] // 60)
        start_sec = int(seg['start'] % 60)
        print(f"  [{start_min}:{start_sec:02d}] {seg['text']}")


if __name__ == '__main__':
    main()

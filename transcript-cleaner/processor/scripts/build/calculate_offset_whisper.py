#!/usr/bin/env python3
"""
Calculate video offset using Whisper transcription.

Alternative to YouTube API method - avoids IP bans and works when:
- YouTube auto-captions aren't available
- Auto-captions start too late (after intro/music)
- Need to bypass YouTube API rate limits

Strategy:
1. Download first 5 minutes of video audio (yt-dlp)
2. Transcribe with Whisper (gets timestamps for each segment)
3. Match first transcript line with Whisper output
4. Return the timestamp where match occurs (within 1-2 seconds accuracy)

This only downloads a small audio sample, avoiding the resource issue.
"""

import whisper
import sys
import json
from pathlib import Path
from difflib import SequenceMatcher
import subprocess
import tempfile
import os


def download_audio_sample(video_id, duration=300, output_path=None):
    """
    Download first N seconds of YouTube video audio using yt-dlp.
    
    Args:
        video_id: YouTube video ID
        duration: Seconds to download (default 300 = 5 minutes)
        output_path: Where to save (default: temp file)
        
    Returns:
        Path to downloaded audio file
    """
    if output_path is None:
        output_path = tempfile.mktemp(suffix='.mp3')
    
    url = f"https://www.youtube.com/watch?v={video_id}"
    
    # yt-dlp command to download first N seconds as mp3
    cmd = [
        'yt-dlp',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '5',  # Lower quality for speed
        '--postprocessor-args', f'-ss 0 -t {duration}',  # First N seconds
        '-o', output_path,
        url
    ]
    
    print(f"Downloading first {duration}s of audio from {video_id}...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        raise Exception(f"yt-dlp failed: {result.stderr}")
    
    # yt-dlp may add extension, find actual file
    base = output_path.rsplit('.', 1)[0]
    for ext in ['.mp3', '.m4a', '.opus']:
        if os.path.exists(base + ext):
            return base + ext
    
    if os.path.exists(output_path):
        return output_path
    
    raise Exception(f"Could not find downloaded file: {output_path}")


def transcribe_with_whisper(audio_path, model_name='base'):
    """
    Transcribe audio with Whisper, getting word-level timestamps.
    
    Args:
        audio_path: Path to audio file
        model_name: Whisper model ('tiny', 'base', 'small', 'medium', 'large')
                   'base' is good balance of speed/accuracy
        
    Returns:
        List of segments with text and timestamps
    """
    print(f"Loading Whisper model '{model_name}'...")
    model = whisper.load_model(model_name)
    
    print(f"Transcribing {audio_path}...")
    result = model.transcribe(
        audio_path,
        language='en',
        verbose=False,
        word_timestamps=True  # Get word-level timing
    )
    
    return result['segments']


def find_text_in_whisper(whisper_segments, reference_text, min_ratio=0.7):
    """
    Find where reference text appears in Whisper transcription.
    
    Args:
        whisper_segments: Segments from Whisper with timestamps
        reference_text: Text to search for (first transcript line)
        min_ratio: Minimum similarity ratio (0-1)
        
    Returns:
        Offset in seconds, or None if not found
    """
    # Clean reference text
    ref_clean = ' '.join(reference_text.upper().split())
    
    # Remove punctuation for matching
    for char in '.,!?;:-"\'()[]{}':
        ref_clean = ref_clean.replace(char, ' ')
    ref_clean = ' '.join(ref_clean.split())
    
    print(f"\nSearching for: {ref_clean[:100]}...")
    
    best_match_time = None
    best_ratio = 0.0
    best_text = None
    
    # Try sliding window of segments
    for i in range(len(whisper_segments)):
        # Build window of 1-5 segments
        for window_size in range(1, min(6, len(whisper_segments) - i + 1)):
            window_segments = whisper_segments[i:i+window_size]
            window_text = ' '.join(seg['text'] for seg in window_segments)
            
            # Clean for comparison
            window_clean = ' '.join(window_text.upper().split())
            for char in '.,!?;:-"\'()[]{}':
                window_clean = window_clean.replace(char, ' ')
            window_clean = ' '.join(window_clean.split())
            
            # Calculate similarity
            ratio = SequenceMatcher(None, ref_clean, window_clean).ratio()
            
            if ratio > best_ratio:
                best_ratio = ratio
                best_match_time = window_segments[0]['start']
                best_text = window_text
                
                if ratio >= min_ratio:
                    print(f"  ✓ Match found at {best_match_time:.1f}s (confidence: {ratio:.1%})")
                    print(f"    Whisper: {best_text[:80]}")
                    return best_match_time
    
    # Return best match even if below threshold
    if best_match_time is not None:
        print(f"  ⚠️  Best match at {best_match_time:.1f}s (confidence: {best_ratio:.1%})")
        print(f"    Whisper: {best_text[:80]}")
        return best_match_time
    
    return None


def parse_timestamp_to_seconds(timestamp_str):
    """
    Parse timestamp like '9:01:40AM' to seconds from meeting start.
    First timestamp is considered 0 seconds.
    
    Args:
        timestamp_str: Timestamp string like '9:01:40AM'
        
    Returns:
        Seconds as integer
    """
    from datetime import datetime
    
    # Parse timestamp
    dt = datetime.strptime(timestamp_str, '%I:%M:%S%p')
    
    # Convert to seconds (from midnight)
    return dt.hour * 3600 + dt.minute * 60 + dt.second


def calculate_offset_from_transcript(video_id, transcript_file, 
                                     sample_duration=120,
                                     whisper_model='base',
                                     cleanup=True):
    """
    Calculate offset by matching Whisper output to official transcript.
    
    Strategy:
    1. Transcribe first N seconds with Whisper (gets video timestamps)
    2. Match Whisper segments to official transcript segments
    3. Use official transcript timestamp + Whisper video timestamp = offset
    
    Args:
        video_id: YouTube video ID
        transcript_file: Path to official transcript JSON
        sample_duration: Seconds to analyze (default 120)
        whisper_model: Whisper model ('tiny', 'base', 'small')
        cleanup: Delete temp audio
        
    Returns:
        Offset in seconds
    """
    audio_path = None
    
    try:
        # Load official transcript
        with open(transcript_file) as f:
            transcript_data = json.load(f)
        
        print(f"✓ Loaded official transcript: {len(transcript_data['segments'])} segments")
        
        # Get first segment timestamp as baseline
        first_timestamp = transcript_data['segments'][0].get('timestamp')
        if not first_timestamp:
            print("⚠️  First segment has no timestamp")
            return None
        
        first_seconds = parse_timestamp_to_seconds(first_timestamp)
        print(f"  First segment timestamp: {first_timestamp} (baseline)")
        
        # Download and transcribe video sample
        audio_path = download_audio_sample(video_id, duration=sample_duration)
        print(f"✓ Downloaded audio sample")
        
        whisper_segments = transcribe_with_whisper(audio_path, model_name=whisper_model)
        print(f"✓ Whisper transcribed {len(whisper_segments)} segments")
        
        # Match Whisper output to official transcript
        # Strategy: Try each Whisper segment until we find one that matches the official transcript
        best_match = None
        best_ratio = 0.0
        
        print("\nSearching for Whisper segments in official transcript...")
        
        # Try each Whisper segment (skip very short ones)
        for w_idx, w_seg in enumerate(whisper_segments):
            whisper_text = w_seg['text'].strip()
            whisper_start_time = w_seg['start']
            
            # Skip very short segments (likely noise/hallucination)
            if len(whisper_text) < 10:
                continue
            
            # Clean Whisper text for comparison
            whisper_clean = whisper_text.upper().strip()
            for char in '.,!?;:-"\'()[]{}':
                whisper_clean = whisper_clean.replace(char, ' ')
            whisper_clean = ' '.join(whisper_clean.split())
            
            # Search through official transcript for this Whisper text
            for i, official_seg in enumerate(transcript_data['segments'][:30]):  # Check first 30
                official_text = official_seg.get('text', '').upper().strip()
                if not official_text or len(official_text) < 10:
                    continue
                
                # Clean for comparison
                official_clean = ' '.join(official_text.split())
                for char in '.,!?;:-"\'()[]{}':
                    official_clean = official_clean.replace(char, ' ')
                official_clean = ' '.join(official_clean.split())
                
                # Use SequenceMatcher to compare the actual text similarity
                # We want to find where Whisper text matches the START of official text
                ratio = SequenceMatcher(None, whisper_clean, official_clean).ratio()
                
                # Boost score if whisper text appears at the beginning of official text
                if official_clean.startswith(whisper_clean[:20]):  # First 20 chars match
                    ratio = max(ratio, 0.9)
                
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_match = {
                        'official_index': i,
                        'official_text': official_text,
                        'whisper_text': whisper_text,
                        'official_timestamp': official_seg.get('timestamp'),
                        'whisper_start': whisper_start_time,
                        'ratio': ratio,
                        'whisper_index': w_idx
                    }
                    
                    if ratio > 0.7:  # Good match found
                        print(f"  ✓ Match found!")
                        print(f"    Whisper segment {w_idx} at {whisper_start_time:.1f}s: \"{whisper_text[:60]}...\"")
                        print(f"    Official segment {i}: \"{official_text[:60]}...\"")
                        print(f"    Confidence: {ratio:.1%}")
                        break
            
            # If we found a good match, stop searching
            if best_ratio > 0.7:
                break
        
        if not best_match or best_ratio < 0.5:
            print(f"  ⚠️  No good match found (best: {best_ratio:.1%})")
            # Fall back to simple mode
            print(f"  → Using simple mode: first speech at {whisper_segments[0]['start']:.1f}s")
            return whisper_segments[0]['start']
        
        # Calculate offset using timestamp math
        # Official transcript tells us this segment is X seconds after meeting start
        # Whisper tells us it's at Y seconds in the video
        # Offset = Y - X (how much video time before meeting starts)
        
        official_seg_timestamp = best_match['official_timestamp']
        official_seg_seconds = parse_timestamp_to_seconds(official_seg_timestamp)
        seconds_from_meeting_start = official_seg_seconds - first_seconds
        
        whisper_video_time = best_match['whisper_start']
        
        offset = whisper_video_time - seconds_from_meeting_start
        
        print(f"\n✓ Match found (confidence {best_match['ratio']:.1%}):")
        print(f"  Official segment #{best_match['official_index']}: {official_seg_timestamp}")
        print(f"  Seconds from meeting start: {seconds_from_meeting_start}s")
        print(f"  Appears in video at: {whisper_video_time:.1f}s")
        print(f"  Calculated offset: {whisper_video_time:.1f}s - {seconds_from_meeting_start}s = {offset:.1f}s")
        print(f"  Official: {best_match['official_text'][:60]}...")
        print(f"  Whisper:  {best_match['whisper_text'][:60]}...")
        
        return offset
        
    finally:
        if cleanup and audio_path and os.path.exists(audio_path):
            os.remove(audio_path)
            print(f"\n✓ Cleaned up temp file")


def calculate_offset_simple(video_id, sample_duration=120, whisper_model='base', cleanup=True):
    """
    Calculate video offset using Whisper - simple approach.
    Just finds when first speech starts in the video.
    
    Args:
        video_id: YouTube video ID
        sample_duration: Seconds of video to analyze (default 120 = 2min)
        whisper_model: Whisper model to use ('tiny', 'base', 'small')
        cleanup: Delete temp audio file after processing
        
    Returns:
        Offset in seconds (when first speech detected)
    """
    audio_path = None
    
    try:
        # Download audio sample
        audio_path = download_audio_sample(video_id, duration=sample_duration)
        print(f"✓ Downloaded to: {audio_path}")
        
        # Transcribe with Whisper
        segments = transcribe_with_whisper(audio_path, model_name=whisper_model)
        print(f"✓ Transcribed {len(segments)} segments")
        
        if not segments:
            print("⚠️  No speech detected")
            return None
        
        # First segment start time IS the offset
        offset = segments[0]['start']
        
        print(f"\n✓ First speech detected at {offset:.1f}s")
        print(f"  Text: {segments[0]['text'][:80]}")
        
        return offset
        
    finally:
        # Cleanup temp file
        if cleanup and audio_path and os.path.exists(audio_path):
            os.remove(audio_path)
            print(f"\n✓ Cleaned up temp file")


def calculate_offset_whisper(video_id, reference_text, 
                             sample_duration=300,
                             whisper_model='base',
                             cleanup=True):
    """
    Calculate video offset using Whisper transcription.
    
    Args:
        video_id: YouTube video ID
        reference_text: First line(s) of transcript to search for
        sample_duration: Seconds of video to analyze (default 300 = 5min)
        whisper_model: Whisper model to use ('tiny', 'base', 'small')
        cleanup: Delete temp audio file after processing
        
    Returns:
        Offset in seconds (or None if failed)
    """
    audio_path = None
    
    try:
        # Download audio sample
        audio_path = download_audio_sample(video_id, duration=sample_duration)
        print(f"✓ Downloaded to: {audio_path}")
        
        # Transcribe with Whisper
        segments = transcribe_with_whisper(audio_path, model_name=whisper_model)
        print(f"✓ Transcribed {len(segments)} segments")
        
        # Find reference text
        offset = find_text_in_whisper(segments, reference_text)
        
        return offset
        
    finally:
        # Cleanup temp file
        if cleanup and audio_path and os.path.exists(audio_path):
            os.remove(audio_path)
            print(f"\n✓ Cleaned up temp file")


def format_time(seconds):
    """Format seconds as MM:SS"""
    if seconds is None:
        return "N/A"
    mins = int(seconds // 60)
    secs = int(seconds % 60)
    return f"{mins}:{secs:02d}"


def main():
    """CLI interface"""
    if len(sys.argv) < 2:
        print("Usage: python calculate_offset_whisper.py <video_id> [options]")
        print("\nRecommended mode (with transcript):")
        print("  python calculate_offset_whisper.py z40gz2O-FHw --transcript 2640")
        print("  Matches Whisper to official transcript for accurate offset")
        print("\nSimple mode (no transcript needed):")
        print("  python calculate_offset_whisper.py z40gz2O-FHw")
        print("  Just finds when first speech starts in video")
        print("\nOptions:")
        print("  --model <name>     Whisper model: tiny, base, small (default: base)")
        print("  --duration <sec>   Sample duration in seconds (default: 120)")
        print("  --transcript <id>  Match against official transcript for accuracy")
        sys.exit(1)
    
    video_id = sys.argv[1]
    
    # Parse options
    whisper_model = 'base'
    sample_duration = 120
    transcript_id = None
    
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == '--model' and i + 1 < len(sys.argv):
            whisper_model = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--duration' and i + 1 < len(sys.argv):
            sample_duration = int(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == '--transcript' and i + 1 < len(sys.argv):
            transcript_id = sys.argv[i + 1]
            i += 2
        else:
            i += 1
    
    print("="*70)
    print("WHISPER-BASED OFFSET CALCULATION")
    print("="*70)
    print(f"\nVideo ID: {video_id}")
    print(f"Model: {whisper_model}")
    print(f"Sample duration: {sample_duration}s")
    
    # Transcript matching mode (recommended)
    if transcript_id:
        print(f"Mode: Transcript matching (accurate)")
        
        # Find transcript file
        transcript_files = list(Path('data/transcripts').glob(f'*{transcript_id}*.json'))
        if not transcript_files:
            print(f"❌ No transcript found for ID {transcript_id}")
            sys.exit(1)
        
        transcript_file = transcript_files[0]
        print(f"Transcript: {transcript_file.name}")
        print()
        
        offset = calculate_offset_from_transcript(
            video_id,
            transcript_file,
            sample_duration=sample_duration,
            whisper_model=whisper_model
        )
    else:
        # Simple mode: just find first speech
        print(f"Mode: Simple (first speech detection)")
        print()
        
        offset = calculate_offset_simple(
            video_id,
            sample_duration=sample_duration,
            whisper_model=whisper_model
        )
    
    print("\n" + "="*70)
    if offset is not None:
        print(f"✅ OFFSET: {offset:.1f} seconds ({format_time(offset)})")
        print(f"\nAdd to video_mapping JSON: \"offset_seconds\": {int(round(offset))}")
    else:
        print("❌ Could not calculate offset")
    print("="*70)


if __name__ == '__main__':
    main()

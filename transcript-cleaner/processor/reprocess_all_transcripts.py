#!/usr/bin/env python3
"""
Re-process all raw transcripts with the new three-layer capitalizer.
Input: data/transcripts/*.json (ALL CAPS)
Output: data/processed/*.json (properly capitalized)

Usage:
    python3 reprocess_all_transcripts.py              # all transcripts
    python3 reprocess_all_transcripts.py --year 2026  # 2026 only
"""

import argparse
import json
import os
from pathlib import Path
from src.capitalize_transcript import TranscriptCapitalizer

def main():
    parser = argparse.ArgumentParser(description='Re-capitalise transcripts')
    parser.add_argument('--year', help='Only process transcripts for this year (e.g. 2026)')
    args = parser.parse_args()

    # Initialize capitalizer
    print("Loading capitalizer (this will load GLiNER model)...")
    capitalizer = TranscriptCapitalizer(use_gliner=True)
    print("✓ Capitalizer ready")
    print()
    
    # Find all transcript files
    transcript_dir = Path('data/transcripts')
    output_dir = Path('data/processed')
    output_dir.mkdir(exist_ok=True)
    
    all_files = sorted(transcript_dir.glob('transcript_*.json'))
    if args.year:
        transcript_files = [f for f in all_files if f'_{args.year}-' in f.name]
        print(f"Filtering for year {args.year}: {len(transcript_files)} of {len(all_files)} files")
    else:
        transcript_files = all_files
    
    if not transcript_files:
        print("No transcript files found in data/transcripts/")
        return
    
    print(f"Found {len(transcript_files)} transcript files to process")
    print()
    
    # Process each file
    processed_count = 0
    skipped_count = 0
    
    for idx, transcript_file in enumerate(transcript_files, 1):
        # Skip the test file we created
        if '--transcript-id' in transcript_file.name:
            skipped_count += 1
            continue
            
        output_file = output_dir / f"processed_{transcript_file.name}"
        
        print(f"[{idx}/{len(transcript_files)}] Processing {transcript_file.name}...")
        
        try:
            # Load transcript
            with open(transcript_file, 'r', encoding='utf-8') as f:
                transcript = json.load(f)
            
            # Check if it has the expected structure
            if 'segments' not in transcript:
                print(f"  ⚠️  Skipping - no 'segments' field")
                skipped_count += 1
                continue
            
            # Process each segment
            for segment in transcript['segments']:
                if 'text' in segment:
                    # Capitalize the text
                    segment['text'] = capitalizer.capitalize_text(segment['text'])
                
                if 'speaker' in segment:
                    # Capitalize speaker name (convert from ALL CAPS to Title Case)
                    speaker = segment['speaker'].strip()
                    if speaker:
                        segment['speaker'] = ' '.join(word.capitalize() for word in speaker.split())
            
            # Save processed transcript
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(transcript, f, indent=2, ensure_ascii=False)
            
            print(f"  ✓ Wrote {len(transcript['segments'])} segments to {output_file.name}")
            processed_count += 1
            
        except Exception as e:
            print(f"  ✗ Error: {e}")
            skipped_count += 1
            continue
    
    print()
    print("=" * 50)
    print(f"Processing complete!")
    print(f"  Processed: {processed_count} files")
    print(f"  Skipped: {skipped_count} files")
    print(f"  Output: data/processed/")
    print("=" * 50)

if __name__ == '__main__':
    main()

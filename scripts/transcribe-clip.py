#!/usr/bin/env python3
"""Quick sanity transcription of a short clip with faster-whisper.
Usage: python3 scripts/transcribe-clip.py <clip.mp4> [model]
Prints [start-end] text lines (clip-relative seconds)."""
import sys
from faster_whisper import WhisperModel

path = sys.argv[1]
model = WhisperModel(sys.argv[2] if len(sys.argv) > 2 else "base", compute_type="int8")
segments, _ = model.transcribe(path, beam_size=1)
for s in segments:
    print(f"[{s.start:6.1f}-{s.end:6.1f}] {s.text.strip()}")

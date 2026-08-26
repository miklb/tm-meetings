#!/usr/bin/env bash
# Concatenate clips into one mashup, re-encoding to a uniform 854x480 h264/aac
# so mismatched source encodes join cleanly. Adds a 0.5s black gap between clips.
# Usage: scripts/mashup-clips.sh <out.mp4> <clip1.mp4> <clip2.mp4> ...
set -euo pipefail
out="$1"; shift
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
list="$tmp/list.txt"; i=0
for c in "$@"; do
  i=$((i+1))
  ffmpeg -y -v error -i "$c" -vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,fps=30,tpad=stop_mode=add:stop_duration=0.5:color=black" \
    -af "apad=pad_dur=0.5" -c:v libx264 -preset fast -crf 22 -c:a aac -ar 48000 -ac 2 "$tmp/$i.mp4"
  echo "file '$tmp/$i.mp4'" >> "$list"
done
ffmpeg -y -v error -f concat -safe 0 -i "$list" -c copy -movflags +faststart "$out"
echo "wrote $out ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")s, $i clips)"

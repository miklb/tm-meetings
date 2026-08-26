#!/usr/bin/env bash
# Clip a section of a YouTube video without downloading the whole thing.
# Usage: scripts/clip-youtube.sh <video_id> <start_sec> <end_sec> <out.mp4>
# Resolves HLS (m3u8) stream URLs (480p h264 + aac) — DASH URLs only yield one ~5s fragment via yt-dlp, then lets
# ffmpeg range-seek into them and stream-copy the window.
set -euo pipefail
vid="$1"; start="$2"; end="$3"; out="$4"
urls=$(yt-dlp -q --no-warnings -g -f "231+234/230+234" "https://www.youtube.com/watch?v=${vid}")
vurl=$(echo "$urls" | sed -n 1p); aurl=$(echo "$urls" | sed -n 2p)
ffmpeg -y -v error -ss "$start" -to "$end" -i "$vurl" -ss "$start" -to "$end" -i "$aurl" \
  -map 0:v -map 1:a -c copy -movflags +faststart "$out"
echo "wrote $out ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out")s)"

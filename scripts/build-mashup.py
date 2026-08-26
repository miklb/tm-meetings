#!/usr/bin/env python3
"""Build a captioned, labelled, fade-transitioned mashup from short clips.

Usage (pipeline venv):
  python3 scripts/build-mashup.py [--no-captions] out.mp4 clip1.mp4 "Label 1" clip2.mp4 "Label 2" ...

Per clip: Whisper-transcribe -> caption PNGs (Pillow) -> ffmpeg overlay of a
lower-third label + timed captions, 0.5s fade in/out (video + audio),
uniform 854x480/30fps/aac. Then concat. No drawtext/libass needed.
"""
import subprocess, sys, tempfile, shutil, textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from faster_whisper import WhisperModel

W, H, FADE = 854, 480, 0.5
CAPTIONS = True
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
INK, GOLD, PAPER = (49, 74, 89, 255), (230, 180, 94, 255), (248, 248, 242, 255)

def run(*cmd):
    subprocess.run(cmd, check=True)

def duration(p):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
        "format=duration", "-of", "csv=p=0", p]).strip())

def label_png(text, path):
    font = ImageFont.truetype(FONT, 22)
    pad = 12
    tw = int(font.getlength(text))
    img = Image.new("RGBA", (tw + 2 * pad, 44), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, img.width, img.height], fill=INK)
    d.rectangle([0, 0, 6, img.height], fill=GOLD)
    d.text((pad + 6, 9), text, font=font, fill=PAPER)
    img.save(path)

def caption_png(text, path):
    font = ImageFont.truetype(FONT, 26)
    lines = textwrap.wrap(text, 52)[:2]
    lh = 36
    img = Image.new("RGBA", (W, lh * len(lines) + 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, ln in enumerate(lines):
        tw = font.getlength(ln)
        x = (W - tw) / 2
        y = 8 + i * lh
        d.rectangle([x - 10, y - 4, x + tw + 10, y + lh - 4], fill=(0, 0, 0, 170))
        d.text((x, y), ln, font=font, fill=(255, 255, 255, 255))
    img.save(path)

def build_clip(src, label, out, tmp, model):
    dur = duration(src)
    segs = model.transcribe(src, beam_size=1)[0] if CAPTIONS else []
    caps = [(s.start, min(s.end, dur), s.text.strip()) for s in segs if s.text.strip()]
    label_png(label, tmp / "label.png")
    inputs = ["-i", src, "-i", str(tmp / "label.png")]
    fc = [f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease,"
          f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps=30[v0]",
          "[v0][1:v]overlay=24:24[v1]"]
    last = "v1"
    for i, (st, en, txt) in enumerate(caps):
        p = tmp / f"cap{i}.png"
        caption_png(txt, p)
        inputs += ["-i", str(p)]
        fc.append(f"[{last}][{i+2}:v]overlay=0:H-h-24:enable='between(t,{st:.2f},{en:.2f})'[v{i+2}]")
        last = f"v{i+2}"
    fc.append(f"[{last}]fade=t=in:d={FADE},fade=t=out:st={dur-FADE:.2f}:d={FADE}[vout]")
    fc.append(f"[0:a]afade=t=in:d={FADE},afade=t=out:st={dur-FADE:.2f}:d={FADE},"
              f"aresample=48000[aout]")
    run("ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(fc),
        "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "fast",
        "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", str(out))
    return caps

def main():
    argv = [a for a in sys.argv[1:] if a != "--no-captions"]
    global CAPTIONS; CAPTIONS = "--no-captions" not in sys.argv
    out, rest = argv[0], argv[1:]
    pairs = list(zip(rest[0::2], rest[1::2]))
    model = WhisperModel("base", compute_type="int8")
    work = Path(tempfile.mkdtemp())
    try:
        listing = work / "list.txt"
        with open(listing, "w") as lf:
            for i, (src, label) in enumerate(pairs, 1):
                tmp = work / f"c{i}"; tmp.mkdir()
                part = work / f"{i:02d}.mp4"
                caps = build_clip(src, label, part, tmp, model)
                print(f"[{i}] {label}: {duration(src):.1f}s, {len(caps)} captions")
                lf.write(f"file '{part}'\n")
        run("ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
            "-c", "copy", "-movflags", "+faststart", out)
        print(f"wrote {out} ({duration(out):.1f}s)")
    finally:
        shutil.rmtree(work)

if __name__ == "__main__":
    main()

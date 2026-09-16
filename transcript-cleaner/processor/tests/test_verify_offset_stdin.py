"""scripts/verify-offset.py must never hand its stdin to ffmpeg.

ffmpeg polls stdin for keyboard commands. Under archive-meeting.sh's multi-pkey
loop the inherited stdin was the here-string of remaining pkeys, and ffmpeg ate
the second one (9/10/26: transcript 2701 silently skipped, exit 0).
"""
import importlib.util
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
VERIFY_OFFSET = REPO_ROOT / "scripts" / "verify-offset.py"


def _load_verify_offset():
    spec = importlib.util.spec_from_file_location("verify_offset", VERIFY_OFFSET)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_extract_clip_never_inherits_stdin(monkeypatch, tmp_path):
    mod = _load_verify_offset()
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["kwargs"] = kwargs
        Path(cmd[-1]).write_bytes(b"\0" * 2000)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    wav = str(tmp_path / "clip.wav")

    assert mod.extract_clip("https://example.invalid/audio.m4a", 10, 15, wav) is True
    assert seen["cmd"][0] == "ffmpeg"
    assert "-nostdin" in seen["cmd"], "ffmpeg must be told not to read stdin"
    assert seen["kwargs"].get("stdin") is subprocess.DEVNULL, "ffmpeg must not inherit our stdin"

"""
Whisper weights are pinned to a Hugging Face commit so an archive build never
downloads new weights mid-run, and a cached model never calls the hub
(2026-10-14; the unpinned load did a GET for `main` on every run).

Run: venv/bin/python -m pytest tests/test_whisper_model_pin.py
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.build.transcribe_with_whisper import PINNED_REVISIONS, model_revision

COMMIT = re.compile(r'^[0-9a-f]{40}$')
HF_HUB = os.path.expanduser('~/.cache/huggingface/hub')


def test_pipeline_model_sizes_are_pinned_to_full_commit_hashes():
    # match_whisper_to_transcript.py defaults to small; transcribe_with_whisper.py to base.
    for size in ('base', 'small'):
        assert COMMIT.match(model_revision(size) or ''), size


def test_unpinned_size_follows_hub_main():
    assert model_revision('medium') is None


@pytest.mark.parametrize('size', sorted(PINNED_REVISIONS))
def test_pin_matches_the_cached_snapshot(size):
    # Guards against a typo in a hash: the machine that archives must hold
    # exactly this snapshot. Skipped where the cache is absent.
    repo = os.path.join(HF_HUB, f'models--Systran--faster-whisper-{size}')
    if not os.path.isdir(repo):
        pytest.skip(f'{repo} not cached here')
    snapshot = os.path.join(repo, 'snapshots', PINNED_REVISIONS[size])
    assert os.path.isfile(os.path.join(snapshot, 'model.bin')), snapshot

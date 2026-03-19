---
applyTo: '**/*.py'
description: 'Python environment setup — venv activation, correct python binary, environment variables. USE WHEN: running any Python script, installing packages, debugging import errors, or suggesting Python commands.'
---

## Python Virtual Environment

This project uses a single Python venv at `transcript-cleaner/processor/venv/`.

### Running Python commands

**Always activate the venv before running any Python script:**

```bash
source pipeline/activate.sh
```

Or explicitly:

```bash
source transcript-cleaner/processor/venv/bin/activate
```

Once activated, both `python` and `python3` resolve to the venv binary.

**When suggesting terminal commands**, always prefix with activation:

```bash
source pipeline/activate.sh && python3 scripts/build/process_video.py 2651 2026-01-08
```

**When running commands via the terminal tool**, always activate first:

```bash
cd /Users/miklb/Sites/meetings/transcript-cleaner/processor && source venv/bin/activate && python3 <command>
```

### Installing packages

Always install into the venv:

```bash
source pipeline/activate.sh && pip install <package>
```

After installing, update the lockfile:

```bash
pip freeze > transcript-cleaner/processor/requirements.lock
```

### Environment variables

The video pipeline requires `YOUTUBE_API_KEY`. The `youtube_fetcher.py` script loads from a `.env` file via `python-dotenv`. Ensure the key is set before running video commands.

### Key paths

| Item | Path |
|------|------|
| venv | `transcript-cleaner/processor/venv/` |
| requirements | `transcript-cleaner/processor/requirements.txt` |
| lockfile | `transcript-cleaner/processor/requirements.lock` |
| activate helper | `pipeline/activate.sh` |
| .python-version | `.python-version` (3.13) |

### Common mistakes

- Running `python3 src/youtube_fetcher.py` without activating the venv — causes `ModuleNotFoundError` for `dotenv`, `gliner`, etc.
- Using system Python to install packages — they won't be available in the venv
- Forgetting that `process_video.py` spawns subprocesses using `sys.executable` — if the parent process isn't the venv Python, children won't have dependencies either

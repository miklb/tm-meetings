"""
Shared logging configuration for the video pipeline.

Call ``setup_logging(meeting_date)`` at the start of any entry-point script.
All modules in this project use ``logging.getLogger(__name__)``; because the
root logger is configured here their messages are automatically routed to both
the per-meeting log file and the console.

Log file location:
    transcript-cleaner/processor/data/logs/pipeline_{date}.log
    (append mode — re-running the same meeting appends to the existing file)

Console format:
    %(message)s  — identical to a raw print() call, preserving existing
    terminal output appearance.

File format:
    2026-05-13 14:32:01 [INFO    ] src.youtube_fetcher: Found 2 video(s)

Usage::

    from src.logging_config import setup_logging

    logger = logging.getLogger(__name__)

    def main():
        setup_logging(meeting_date="2025-10-23")
        logger.info("Starting pipeline...")
"""

import logging
import sys
from datetime import date
from pathlib import Path


def setup_logging(
    meeting_date: str | None = None,
    log_dir: "Path | str | None" = None,
) -> logging.Logger:
    """
    Configure the root logger for a pipeline run.

    Sets up two handlers:

    - **FileHandler** → ``data/logs/pipeline_{meeting_date}.log``
      (append mode, DEBUG+, full format with timestamp / level / module)
    - **StreamHandler** → stdout
      (INFO+, message-only format — terminal output looks identical to print())

    Calling this multiple times is safe: existing handlers are cleared and
    replaced so there are no duplicates.

    Args:
        meeting_date: ``"YYYY-MM-DD"`` string. Defaults to today's date when
            not provided (useful for standalone CLI invocations).
        log_dir: Override the log directory.  Defaults to ``data/logs/``
            relative to the processor root (parent of ``src/``), regardless
            of the current working directory.

    Returns:
        The root ``logging.Logger``.
    """
    date_str = meeting_date or date.today().isoformat()

    if log_dir is None:
        # Resolve data/logs/ relative to the processor root regardless of cwd
        processor_root = Path(__file__).resolve().parent.parent
        log_dir = processor_root / "data" / "logs"
    else:
        log_dir = Path(log_dir)

    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"pipeline_{date_str}.log"

    root = logging.getLogger()

    # Clear any previously-added handlers (handles re-calls and any
    # module-level basicConfig() calls that ran before this function).
    root.handlers.clear()

    root.setLevel(logging.DEBUG)

    # File handler: full context — useful for post-run analysis
    fh = logging.FileHandler(log_path, mode="a", encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    root.addHandler(fh)

    # Console handler: message only — keeps terminal output identical to print()
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(ch)

    return root

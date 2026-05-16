# GLiNER Transcript Processing — Workflow Evaluation & Suggestions

_Last evaluated: May 13, 2026_

This document evaluates the current GLiNER-based entity extraction workflow used
by the transcript capitalizer and proposes improvements, including a concrete
weekly workflow keyed to newly-scraped agendas.

---

## 1. Current State

### 1.1 What GLiNER is doing today

The system uses **off-the-shelf `urchade/gliner_small-v2.1` in zero-shot mode** —
no fine-tuning, no labeled dataset, no custom training loop. GLiNER is one of
three layers in the capitalization pipeline:

1. **Standard entities** ([standard_entities.json](../transcript-cleaner/processor/data/standard_entities.json)) — countries, states, holidays, Tampa geographic features (public-domain sources).
2. **Agenda-extracted entities** ([hybrid_entity_database.json](../transcript-cleaner/processor/data/hybrid_entity_database.json)) — people and organizations harvested from scraped agendas. **This is the only place GLiNER runs.**
3. **Heuristic rules** in [capitalize_transcript.py](../transcript-cleaner/processor/src/capitalize_transcript.py).

### 1.2 Extraction pipeline

[extract_agenda_entities.py](../transcript-cleaner/processor/scripts/build/extract_agenda_entities.py) implements a **hybrid extractor**:

- Regex patterns extract titled people (`Chief Barbara Tripp`), `Memorandum from …`, departments, common org suffixes — high precision.
- GLiNER predicts `person`, `organization`, `company`, `department` over 250-word chunks (the model's ~384-token limit).
- Results are merged with a confidence rule:
  - Rules + GLiNER agree → `1.0`
  - Rules only → `0.9`
  - GLiNER only → `0.5`
- Across all agendas, an entity's final `score = frequency × avg_confidence`.

Post-processing in [clean_entity_database.py](../transcript-cleaner/processor/scripts/build/clean_entity_database.py):

- Strips role-only entries (`zoning administrator`, `city clerk`, …).
- Moves business names (`… Inc.`, `… LLC`) from `people` → `organizations`.
- Deduplicates name variants (`Brad Baird` / `Brad L. Baird`) and fixes
  hyphenated casing (`Johnson-velez` → `Johnson-Velez`).

### 1.3 Current entry points

| Script                                                                                                                    | Purpose                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [pipeline/rebuild-entities.sh](../pipeline/rebuild-entities.sh)                                                           | Project-root wrapper — the intended weekly entry point.    |
| [transcript-cleaner/processor/scripts/build/rebuild_all.sh](../transcript-cleaner/processor/scripts/build/rebuild_all.sh) | 4-step orchestrator (extract → clean → acronyms → verify). |
| [extract_agenda_entities.py](../transcript-cleaner/processor/scripts/build/extract_agenda_entities.py)                    | GLiNER + regex extraction.                                 |
| [extract_config.py](../transcript-cleaner/processor/scripts/build/extract_config.py)                                      | Acronym discovery into `capitalization_config.json`.       |

---

## 2. Assessment

### 2.1 What works well

- **Zero-shot is good enough for ~80% of names** in Tampa agendas. Most error sources are recoverable in post-processing (`clean_entity_database.py`).
- **Hybrid rules + ML gating** is the right shape: the rule layer prevents the
  worst zero-shot failures (hallucinated "people" like `Equal Opportunity`).
- **Frequency weighting** across agendas is a cheap, effective denoising signal.
- **Idempotent rebuild** — re-running the script is safe; output is fully derived from inputs.

### 2.2 Real weaknesses

| #   | Issue                                                                                                                                                              | Evidence                                        | Impact                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | **No fine-tuning, no labeled data.** GLiNER never learns Tampa-specific patterns (CRA, MPO, THA, councilmember surnames).                                          | `urchade/gliner_small-v2.1` loaded as-is.       | Recall ceiling on niche names; same false positives recur every rebuild.                           |
| 2   | **No feedback loop from transcripts.** Capitalization errors found while reviewing transcripts don't flow back into the entity DB.                                 | No `corrections.json`, no diff/audit step.      | Same mis-capitalizations repeat across meetings.                                                   |
| 3   | **Agenda-only training signal.** Agendas use Title Case; transcripts arrive ALL CAPS with disfluencies. Distribution mismatch.                                     | GLiNER only ever sees agenda text.              | Misses speakers who appear in transcripts but not agendas (public commenters, visiting officials). |
| 4   | **No evaluation metric.** No held-out set, no precision/recall tracked over time.                                                                                  | No `evaluation/` directory; no test fixtures.   | Regressions in the cleaner are invisible.                                                          |
| 5   | **Cleaner thresholds are guesses.** GLiNER threshold (0.5/0.6), chunk size (250 words), name-length bounds (2–4 words) are hand-tuned with no measurement.         | Constants hard-coded.                           | Suboptimal trade-off between recall and noise.                                                     |
| 6   | **Two model loads per rebuild.** GLiNER is loaded inside `extract_agenda_entities.py` even when re-running on the same corpus.                                     | ~30s cold start.                                | Slow iteration during tuning.                                                                      |
| 7   | **No versioning of the entity DB.** Each rebuild overwrites `hybrid_entity_database.json`.                                                                         | No `data/snapshots/`.                           | Can't compare week-over-week; can't roll back a bad rebuild.                                       |
| 8   | **GLiNER not actually used at capitalization time** (despite being importable).                                                                                    | `capitalize_transcript.py` reads the static DB. | The DB is the bottleneck — anything missed at rebuild is permanently missed for that week.         |
| 9   | **Rebuild trigger is manual.** Nothing forces `rebuild-entities.sh` to run after `process-agenda.sh`.                                                              | Not chained in `process-agenda.sh`.             | New agendas may be processed against stale entity data.                                            |
| 10  | **Schema drift between regex and GLiNER labels.** GLiNER returns `company` / `department` but they're folded into `organizations` without preserving the sub-type. | Lossy merge in `extract_entities_hybrid`.       | Can't later filter for "departments only" without re-running.                                      |

---

## 3. Recommendations

Recommendations are grouped by effort. Pick a tier; the higher tiers assume the lower ones are in place.

### Tier 1 — Operational hygiene (low effort, high ROI)

1. **Chain entity rebuild into the agenda pipeline.** Append a step to
   [agenda-scraper/process-agenda.sh](../agenda-scraper/process-agenda.sh) (or to a new top-level `bin/weekly.sh`) that runs `./pipeline/rebuild-entities.sh` after WP HTML generation. This eliminates issue #9.

2. **Snapshot the entity DB.** Before overwriting, copy
   `hybrid_entity_database.json` to
   `transcript-cleaner/processor/data/snapshots/hybrid_entity_database.<ISO-date>.json`.
   Keeps a week-over-week diff trivial and supports rollback.

3. **Write a weekly diff report.** New script `scripts/build/diff_entity_db.py`:
   prints entities added / removed / score-changed since the previous snapshot.
   Catches regressions and surfaces newly-introduced names for human review.

4. **Persist GLiNER sub-types.** Keep `company` and `department` tags in the DB
   (`{"type": "department", …}`) rather than collapsing them into a flat
   `organizations` map.

5. **Cache the GLiNER model load.** Use `functools.lru_cache` or a module-level
   singleton so multiple scripts in one run share the loaded model.

### Tier 2 — Quality signal & feedback loop (medium effort)

6. **Create a `corrections.jsonl` register.** Format:

   ```json
   {
     "wrong": "barbara tripp",
     "right": "Barbara Tripp",
     "type": "person",
     "source": "transcript:2645",
     "added": "2026-05-13"
   }
   ```

   `clean_entity_database.py` applies these as post-rebuild overrides. Manual
   transcript fixes become permanent and self-documenting.

7. **Build a small evaluation set.** Hand-label entities in 5 agendas (e.g., one
   per meeting type) once. Store as
   `transcript-cleaner/processor/eval/gold/<date>.json`. Add
   `scripts/build/evaluate_extraction.py` that reports per-rebuild
   precision / recall against gold. Even a 5-doc set catches catastrophic
   regressions.

8. **Sweep thresholds.** With (7) in place, grid-search GLiNER threshold (0.4–0.8)
   and chunk size (150 / 250 / 350 words). Commit chosen values with the
   F1 number that justified them.

9. **Extract from transcripts, not just agendas.** Once a cleaned transcript
   exists, run the same hybrid extractor on it. Speakers appearing only in
   public comment (not on the agenda) become first-class entities. Tag them
   with `source: transcript` so they can be down-weighted if desired.

### Tier 3 — Actual fine-tuning (higher effort, real model improvement)

10. **Build a fine-tuning corpus from the corrections register + gold set.**
    GLiNER's training format is BIO-tagged JSON. Once
    `corrections.jsonl` + the gold eval set together exceed ~500 spans,
    fine-tuning becomes worthwhile.

11. **Add a `train/` directory** at
    `transcript-cleaner/processor/scripts/train/` with:
    - `prepare_dataset.py` — converts agendas + gold + corrections → GLiNER JSONL.
    - `finetune_gliner.py` — runs `Trainer` on `gliner_small-v2.1`, saves to
      `data/models/gliner-tampa-vN/`.
    - `evaluate_model.py` — compares fine-tuned vs base on the held-out set.

12. **Pin a model version per rebuild.** Write
    `{"model": "gliner-tampa-v3", "trained": "2026-05-10"}` into the entity DB
    metadata so a future regression can be traced to a specific checkpoint.

13. **Re-train on a quarterly cadence**, not weekly. Weekly fine-tuning is overkill;
    quarterly absorbs accumulated corrections and new speakers without churn.

---

## 4. Proposed Weekly Workflow

Goal: a single command per meeting that keeps the entity DB fresh and produces
an auditable diff, without requiring any human edits to JSON.

### 4.1 One-line target

```bash
./bin/weekly.sh 2026-05-14    # date of the meeting being added
```

### 4.2 What it should run (in order)

```
1. agenda-scraper/process-agenda.sh <date>
     ├── json-scraper.js          (scrape agenda JSON)
     ├── mirror-documents.js      (upload docs to R2, stamp mirroredUrl)
     └── json-to-wordpress.js     (build WP HTML)

2. pipeline/rebuild-entities.sh
     ├── snapshot existing hybrid_entity_database.json   ← new
     ├── extract_agenda_entities.py                       (regex + GLiNER)
     ├── clean_entity_database.py                         (dedupe, casing)
     ├── apply_corrections.py        ← new (Tier 2 item 6)
     ├── extract_config.py                                (acronyms)
     └── diff_entity_db.py           ← new (Tier 1 item 3)

3. (when transcript is available, separately)
   transcript-cleaner/processor/scripts/build/process_meeting.sh <date>
     ├── capitalize_transcript.py    (uses fresh entity DB)
     ├── extract_from_transcript.py  ← new (Tier 2 item 9)
     └── append transcript-source entities back into DB with source tag
```

### 4.3 Cadence

| Cadence                              | Action                                                                                       | Trigger                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Per meeting** (weekly)             | Run `bin/weekly.sh <date>` after agenda is published.                                        | New agenda on the city calendar.                                 |
| **Per transcript** (weekly, lagging) | Re-extract from cleaned transcript; append to DB.                                            | Whisper/YouTube transcript appears.                              |
| **Monthly**                          | Review `data/snapshots/` diffs; promote recurring transcript entities to `confidence ≥ 0.9`. | Calendar reminder.                                               |
| **Quarterly**                        | Run `scripts/train/finetune_gliner.py`. Publish new `gliner-tampa-vN`.                       | When corrections.jsonl grows by ≥100 entries _or_ eval F1 drops. |
| **Annually**                         | Refresh `standard_entities.json` from public-domain sources.                                 | Calendar reminder.                                               |

### 4.4 Acceptance criteria for "the workflow worked this week"

- `rebuild_all.sh` exit code `0`.
- `diff_entity_db.py` report committed/saved alongside the snapshot.
- New `people` count change is within ±20% of the rolling 4-week average
  (alert if it spikes — usually means a regex broke).
- Eval set precision/recall (once Tier 2 lands) within 2 points of the previous run.

---

## 5. Suggested Implementation Order

If you do nothing else, do these in order — each is independently useful:

1. **Tier 1 #1** — chain rebuild into `process-agenda.sh`. (~10 min.)
2. **Tier 1 #2** — snapshot the DB. (~30 min.)
3. **Tier 1 #3** — `diff_entity_db.py`. (~1 hr.)
4. **Tier 2 #6** — `corrections.jsonl` + applier. (~2 hr.)
5. **Tier 2 #7** — gold eval set + scorer. (~3 hr labeling + 1 hr code.)
6. **Tier 2 #9** — pull entities from transcripts. (~2 hr.)
7. **Tier 3** — only after #4 and #5 have produced ≥500 labeled spans.

Stop at Tier 2 if the precision/recall numbers from #7 are acceptable.
Fine-tuning is the most expensive option and the one with the most uncertain
return — get measurement in place first so you can tell whether it actually
helped.

---

## 6. Open Questions

- Is there a manual review step planned for transcripts, or are they published
  unverified? (Determines whether `corrections.jsonl` is human- or
  reviewer-driven.)
- Are public commenter names a goal? They're the strongest argument for
  transcript-side extraction (Tier 2 #9), but raise privacy considerations.
- Should the entity DB be committed to git? Snapshots argue yes; size (~800 KB)
  argues for git-lfs or a separate artifacts bucket.

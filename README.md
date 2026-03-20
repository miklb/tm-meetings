# Tampa Meetings

_A civic transparency tool that scrapes, processes, and publishes Tampa City Council meeting records. Combines structured agenda data with processed transcripts and YouTube video sync._

This project was born out of a manual process and a lot of experimenting with cobbled together scripts and going back to the drawing board. Over the course of late 2025 to the spring of 2026 I leveraged GitHub Copilot and Claude to expidite the process of making the idea a reality. Beating a bunch of machines into submission to produce an end result. This project and the code that executes all of it relies heavily on the work of dedicated public servants and open source developers.

It was developed specifically for the City of Tampa and the various public data sources available. It's intended to be run once a week to do one job. It's not critical infrastructure, it's just an automated process at the end of the day.

The code is public for transparency and posterity.

---

## Project Status

The pipeline is unified and actively processing 2026 meetings end-to-end — scraping agendas, processing transcripts, syncing YouTube video, and publishing to the static site. Current work focuses on backfilling meetings, UI/UX improvements, and edge-case fixes. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for architecture decisions and remaining work items.

### What Works Today

| Component                       | Status   | Location                                |
| ------------------------------- | -------- | --------------------------------------- |
| Agenda Scraper (HTTP-first v3)  | Active   | `agenda-scraper/`                       |
| Transcript Processor            | Active   | `transcript-cleaner/processor/`         |
| WordPress Publication           | Active   | Agendas published via block markup      |
| Nightly Scrape (GitHub Actions) | Active   | `.github/workflows/nightly-scrape.yml`  |
| Eleventy Static Site            | Built    | `site/`                                 |
| SQLite Database                 | Built    | 57+ meetings, FTS5 search               |
| R2 Document Mirroring           | Active   | Cloudflare R2 via `mirror-documents.js` |
| Pipeline Orchestration          | Active   | `pipeline/`                             |
| Video/Transcript Sync           | Complete | 5-step pipeline, 30+ videos integrated  |

### What's Planned

| Component                   | Status      |
| --------------------------- | ----------- |
| Pagefind search             | Not started |
| Datasette API               | Future      |
| GitHub Actions for pipeline | Planned     |

---

## Components

### Agenda Scraper

Extracts structured data from the City of Tampa's Hyland OnBase meeting system.

```bash
cd agenda-scraper
npm install

# Scrape a specific meeting by ID
node json-scraper.js 2650

# Process + convert to WordPress format
./process-agenda.sh 2650
```

**Output:** JSON data files in `agenda-scraper/data/` + WordPress HTML in `agenda-scraper/agendas/`

**Data extracted:** File numbers, titles, backgrounds, supporting documents, locations, coordinates, dollar amounts, fiscal impact details.

### Transcript Processor

Converts ALL CAPS meeting transcripts to sentence case with named entity recognition and YouTube video synchronization.

```bash
cd transcript-cleaner/processor
pip install -r requirements.txt

# Process a transcript
python src/transcript_processor.py --meeting-id 2640
```

**Output:** Processed JSON + static HTML pages with video sync in `transcript-cleaner/processor/output/site/`

---

## Architecture

```
Hyland OnBase ──▶ agenda-scraper/     ──▶ JSON data + WordPress HTML
                    ├── json-scraper.js      (scrape meetings)
                    ├── mirror-documents.js   (upload docs to R2)
                    └── json-to-wordpress.js  (generate WP markup)

tampagov.net  ──▶ transcript-cleaner/ ──▶ Processed JSON + HTML
                    └── processor/           (NER, case, video sync)

pipeline/     ──▶ Orchestration       ──▶ SQLite DB + Eleventy site
                    ├── discover.py          (find new meetings)
                    ├── process-meeting.sh   (end-to-end per meeting)
                    └── build-site.sh        (rebuild DB + site)

site/         ──▶ Eleventy            ──▶ Static HTML pages
                    └── meetings.db          (SQLite with FTS5)
```

---

## Data Sources

| Source      | URL                          | Content                                              |
| ----------- | ---------------------------- | ---------------------------------------------------- |
| Agendas     | tampagov.net (Hyland OnBase) | Meeting agendas, staff reports, supporting documents |
| Transcripts | tampagov.net                 | Official meeting transcripts (ALL CAPS)              |
| Video       | YouTube (Tampa TV)           | Full meeting recordings with chapter markers         |

---

## Meeting Types

| Code | Full Name                      | Frequency         |
| ---- | ------------------------------ | ----------------- |
| CC   | City Council                   | Weekly (Thursday) |
| CRA  | Community Redevelopment Agency | Thursdays         |
| EVE  | Evening Session                | Thursday Evening  |
| WS   | Workshop                       | Thursdays         |
| SP   | Special Meeting                | As needed         |

---

## Prerequisites

- Node.js 20+
- Python 3.11+ (3.12 recommended for transcript processor)
- SQLite 3

---

## Accessibility

This project prioritizes accessibility (WCAG 2.1 AA minimum):

- Semantic HTML throughout
- Full keyboard navigation
- ARIA landmarks and roles for assistive technology
- Transcripts provide accessible alternative to video
- High contrast, readable typography

---

## Documentation

| Document                                                                             | Purpose                                        |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)                                     | Full roadmap, database schema, decisions log   |
| [BUGS.md](BUGS.md)                                                                   | Known issues                                   |
| [pipeline/README.md](pipeline/README.md)                                             | Pipeline scripts, data flow, typical workflows |
| [pipeline/REPROCESS_2026.md](pipeline/REPROCESS_2026.md)                             | Runbook for full 2026 data refresh             |
| [agenda-scraper/README.md](agenda-scraper/README.md)                                 | Scraper v3.0 usage, options, output format     |
| [transcript-cleaner/processor/README.md](transcript-cleaner/processor/README.md)     | Transcript processor setup and usage           |
| [transcript-cleaner/processor/WORKFLOW.md](transcript-cleaner/processor/WORKFLOW.md) | Manual processing steps and video offset guide |

Component-specific docs (library API, R2 mirroring, YouTube setup, video pipeline design) live in their respective directories. Historical docs are in `archive/`.

---

## Related Projects

- [miklb/agenda-scraper](https://github.com/miklb/agenda-scraper) — Original agenda scraper repo

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

_A [Tampa Monitor](https://tampamonitor.com) project_

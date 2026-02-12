# Tampa Meetings

A civic transparency tool that scrapes, processes, and publishes Tampa City Council meeting records. Combines structured agenda data with processed transcripts and YouTube video sync.

---

## Project Status

**This project is in active development.** The two core tools work independently and are being unified into a single platform. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the full roadmap.

### What Works Today

| Component                       | Status            | Location                                                              |
| ------------------------------- | ----------------- | --------------------------------------------------------------------- |
| Agenda Scraper                  | Active, automated | `agenda-scraper/` ([GitHub](https://github.com/miklb/agenda-scraper)) |
| Transcript Processor            | Functional, local | `transcript-cleaner/processor/`                                       |
| WordPress Publication           | Active            | Agendas published via WordPress block markup                          |
| Nightly Scrape (GitHub Actions) | Running           | `agenda-scraper/.github/workflows/`                                   |

### What's Planned

| Component                      | Status      |
| ------------------------------ | ----------- |
| Transcript processor hardening | In progress |
| Unified `tampa-meetings` repo  | Not started |
| Eleventy static site           | Not started |
| SQLite database                | Not started |
| Pagefind search                | Not started |
| R2 document mirroring          | Not started |
| Datasette API                  | Future      |

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

## Architecture (Current)

```
agenda-scraper/          ──▶  JSON data + WordPress HTML
  └── GitHub Actions         (nightly scrape, auto-commit)

transcript-cleaner/      ──▶  Processed JSON + static HTML
  └── Manual runs            (sentence case, NER, video sync)
```

## Architecture (Planned)

```
┌─────────────────────────────────────────────────────────────────┐
│                    STATIC SITE (Eleventy)                        │
│               meetings.tampamonitor.com                          │
│      Pre-rendered meeting pages + Pagefind search               │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Cloudflare Pages (free)
                              │
┌─────────────────────────────────────────────────────────────────┐
│                      SQLite Database                             │
│              Read at build time via better-sqlite3              │
│        Agenda data + transcript data + FTS5 search              │
└─────────────────────────────────────────────────────────────────┘
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
- Screen reader tested (VoiceOver)
- Transcripts provide accessible alternative to video
- High contrast, readable typography

---

## Related Projects

- [miklb/agenda-scraper](https://github.com/miklb/agenda-scraper) — Agenda scraping (will be archived when unified repo is created)

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

_A [Tampa Monitor](https://tampamonitor.com) project_

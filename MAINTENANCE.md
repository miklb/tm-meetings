# Meetings Maintenance & Dependency Chores

A schedule for keeping runtime dependencies, tooling, and Node.js versions current.

---

## ⚠️ One-off: AI instruction-file audit (added 2026-07-03)

The `.github/` agent instruction files were shaped by older models and have drifted from the code. Verified issues, ordered by impact:

- [x] **Venv contradiction.** [.github/instructions/python-environment.instructions.md](.github/instructions/python-environment.instructions.md) and the "Python Environment" section of [.github/copilot-instructions.md](.github/copilot-instructions.md) both claim the project uses a **single** venv, but `opengov/` has its own venv (per [opengov.instructions.md](.github/instructions/opengov.instructions.md)). Fix the wording in both, and consider narrowing python-environment's `applyTo: "**/*.py"` glob to exclude `opengov/**` so the two files never both apply with conflicting advice. The root `CLAUDE.md` documents the two-venv reality — keep it in sync. — done 2026-09-07 (opengov venv moved to repo-root `.venv`; `applyTo` narrowed to exclude opengov)
- [x] **opengov.instructions.md "Things that have NOT been built yet" is stale.** Per-item funding insertion **is** built: the live emitter `json-to-markdown.js` imports `loadFundingManifest` / `buildFundingByItemId` from `lib/render-funding` and renders per-item financial sections plus an agenda-level overview. Remove that bullet and point the doc at `json-to-markdown.js` (WP generation retired 2026-07-17). The other two bullets (select-endpoint amounts, fiscal-year ledger) re-verified 2026-09-07 and still accurate. — done 2026-09-07
- [x] **copilot-instructions.md directory tree is wrong.** `pipeline/scrapers/`, `pipeline/processors/`, `pipeline/scripts/`, and `data/agendas/` don't exist; the tree omits `agenda-scraper/`, `transcript-cleaner/`, `opengov/`, and `scripts/`. Redraw from the actual layout. — done 2026-09-07
- [x] **copilot-instructions.md "Common Tasks" is stale.** No `MEETING_TYPES` constant exists anywhere in the repo; the Datasette task references `pipeline/scripts/build-database.py` and `deploy-datasette.sh`, which don't exist (Datasette was replaced by Cloudflare D1 — the real DB build is `scripts/build-db.js`). — done 2026-09-07 (Datasette task removed; meeting-type touchpoints redirected to `scripts/build-db.js`)
- [x] **copilot-instructions.md "Automated Checks" lists `npm run lint`** — no package.json in the repo defines a lint script. Either add one or drop the claim. — done 2026-09-07 (dropped; verification is `cd site && npm run build` + manual checklist)
- [x] **Decide the WCAG target.** Repo files say WCAG 2.1 AA; the Tampa Monitor shared conventions target 2.2 AA. Pick one and align copilot-instructions.md, README, and CLAUDE.md. — done 2026-09-07: decided 2.2 AA everywhere
- [x] Bump the `_Last updated_` stamp in copilot-instructions.md when done. — done 2026-09-07

---

## Node.js

Node.js uses **year-based versioning** with an 18-month Active LTS window:

| Version | Released | Active LTS Starts | Active LTS Ends | Status    |
| ------- | -------- | ----------------- | --------------- | --------- |
| 26      | Apr 2026 | Oct 2026          | Apr 2028        | Current ✓ |
| 28      | Apr 2027 | Oct 2027          | Apr 2029        | Future    |

This repo is pinned to Node **26** (matching toolshed) in `.nvmrc`,
`.github/workflows/nightly-scrape.yml`, and the README. Upgraded from EOL
Node 20 in July 2026.

Actionable checklists for the cadences below live as NotePlan templates in
[`maintenance/noteplan/`](maintenance/noteplan/) — see
[`maintenance/README.md`](maintenance/README.md) for setup.

**Rules:**

- `.nvmrc` in the repo root pins the Node version — commit version changes there.
- No need to run `nvm use` manually. Add this hook to `~/.zshrc` and it auto-activates when you `cd` into any directory with a `.nvmrc`:

  ```zsh
  autoload -U add-zsh-hook
  load-nvmrc() {
    local nvmrc_path="$(nvm_find_nvmrc)"
    if [ -n "$nvmrc_path" ]; then
      local nvmrc_ver=$(nvm version "$(cat "$nvmrc_path")")
      [ "$nvmrc_ver" = "N/A" ] && nvm install || [ "$nvmrc_ver" != "$(nvm version)" ] && nvm use
    fi
  }
  add-zsh-hook chpwd load-nvmrc
  load-nvmrc
  ```

- When a new major ships in April, evaluate upgrading after it hits Active LTS in October.
- Flag and update `.nvmrc` and `nightly-scrape.yml` within one month of LTS activation.

---

## Dependency Inventory

### Node.js (npm)

| Package                   | Location             | Purpose                     | Check                                    |
| ------------------------- | -------------------- | --------------------------- | ---------------------------------------- |
| `axios`                   | `agenda-scraper/`    | HTTP scraping client        | `npm outdated` in `agenda-scraper/`      |
| `axios-cookiejar-support` | `agenda-scraper/`    | Cookie session support      | same                                     |
| `cheerio`                 | `agenda-scraper/`    | HTML parsing                | same                                     |
| `@aws-sdk/client-s3`      | `agenda-scraper/`    | R2 document mirroring       | same                                     |
| `pdf-parse` / `pdfreader` | `agenda-scraper/`    | PDF text extraction (`pdf2json` is a version override only, needed by `pdfreader` — see maintenance/README.md major-version backlog) | same |
| `tough-cookie`            | `agenda-scraper/`    | Cookie jar                  | same                                     |
| `dotenv`                  | `agenda-scraper/`    | Environment variables       | same                                     |
| `@11ty/eleventy`          | `site/`              | Static site generator       | `npm outdated` in `site/`                |
| `better-sqlite3`          | `site/` + `scripts/` | SQLite access               | `npm outdated` in `site/` and `scripts/` |
| `glob`                    | `scripts/`           | File globbing for build-db  | `npm outdated` in `scripts/`             |
| Node.js                   | Runtime              | All JS execution            | https://nodejs.org/en/about/releases     |

### Python (`transcript-cleaner/processor/venv`)

Source of truth: `transcript-cleaner/processor/requirements.txt` and `opengov/requirements.txt` (`httpx` only). Utility deps (`click`, `rich`, `tqdm`, `python-dateutil`) are omitted from the table.

| Package                    | Purpose                      | Check                                  |
| -------------------------- | ---------------------------- | -------------------------------------- |
| `gliner`                   | NER entity recognition       | `pip list --outdated` (activate first) |
| `beautifulsoup4`           | HTML parsing                 | same                                   |
| `requests`                 | HTTP in Python scripts       | same                                   |
| `lxml`                     | XML/HTML parser backend      | same                                   |
| `jinja2`                   | HTML template generation     | same                                   |
| `google-api-python-client` | YouTube Data API             | same                                   |
| `yt-dlp`                   | Audio extraction for Whisper | same                                   |
| `faster-whisper`           | Whisper offset calculation   | same                                   |
| `google-auth`              | YouTube API auth             | same                                   |
| `httpx`                    | opengov/ HTTP client         | `pip list --outdated` in opengov venv  |
| `python-dotenv`            | Environment variables        | transcript venv only (not in opengov)  |

---

## Chore Schedule

### Monthly (first Monday of each month)

- [ ] Run `npm outdated` in `agenda-scraper/`, `site/`, and `scripts/` — apply patch updates
- [ ] Check `yt-dlp` (releases frequently): `pip install --upgrade yt-dlp` in transcript venv

### Quarterly (Jan, Apr, Jul, Oct)

- [ ] `source pipeline/activate.sh && pip list --outdated` — review and apply safe upgrades
- [ ] Review Node.js minor/patch: `nvm ls-remote 26 | tail -5` — update `.nvmrc` to latest `26.x.x` if desired
- [ ] Review `@11ty/eleventy` for minor/major releases (breaking changes common on majors)

### Annually (October — aligns with Node LTS activation)

- [ ] Evaluate upgrading to new Node.js LTS major
  - Update `.nvmrc`, `.github/workflows/nightly-scrape.yml` (`node-version`), `README.md` prerequisites, and the Node table in this file
- [ ] Audit all dependencies for EOL or known CVEs
- [ ] Review Python version compatibility

---

## Chore Log

| Date       | Chore   | Notes |
| ---------- | ------- | ----- |
| 2026-09-07 | Monthly | `npm update` in `agenda-scraper/` (aws-sdk, axios, selenium in-range); `site/` and `scripts/` clean. yt-dlp 2026.8.17-dev → 2026.8.19. Majors deferred: `axios-cookiejar-support` 7, `pdf-parse` 2, `tough-cookie` 6, `better-sqlite3` 13. One-off audit above still fully open. |

---

## Upgrade Checklist (Node.js major bump)

1. `nvm install <version> && nvm alias default <version>`
2. Update `.nvmrc` to new major
3. Update `node-version` in `.github/workflows/nightly-scrape.yml`
4. Update `README.md` prerequisites line
5. Update the Node table at the top of this file
6. Run `npm ci` in `agenda-scraper/`, `site/`, `scripts/` and verify no breakage
7. Commit: `chore: upgrade to Node <version>`

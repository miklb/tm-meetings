# Meetings Maintenance & Dependency Chores

A schedule for keeping runtime dependencies, tooling, and Node.js versions current.

---

**Instruction-file audit (added 2026-07-03):** completed 2026-09-07, every item fixed. The itemized list is in this file's history before that date.

---

## Node.js

Node.js uses **year-based versioning**: 12 months of Active LTS from October, then 18 months of Maintenance LTS; end of life is 36 months after release:

| Version | Released | Active LTS Starts | Active LTS Ends | Maintenance Ends | Status    |
| ------- | -------- | ----------------- | --------------- | ---------------- | --------- |
| 26      | Apr 2026 | 2026-10-28        | Oct 2027        | Apr 2029         | Current ✓ |
| 28      | Apr 2027 | Oct 2027          | Oct 2028        | Apr 2030         | Future    |

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
- npm 11.20 (bundled from Node 26.13) blocks dependency install scripts unless a
  package's `allowScripts` lists them. `site/` and `scripts/` deny
  `better-sqlite3` and `site/` denies `fsevents`: both ship prebuilt binaries,
  and their only install hook is npm's implicit `node-gyp rebuild`. After any
  install, `npm install-scripts ls` in each dir should print nothing; a new
  entry needs an approve or deny decision before the next commit.

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

### Python (`transcript-cleaner/processor/venv`; root `.venv` for `opengov/`)

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
| `httpx`                    | opengov/ HTTP client         | `pip list --outdated` in root `.venv`  |
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
| 2026-09-07 | Monthly | `npm update` in `agenda-scraper/` (aws-sdk, axios, selenium in-range); `site/` and `scripts/` clean. yt-dlp 2026.8.17-dev → 2026.8.19. Majors deferred: `axios-cookiejar-support` 7, `pdf-parse` 2, `tough-cookie` 6, `better-sqlite3` 13. Instruction-file audit (2026-07-03) completed the same day. |
| 2026-10-12 | Monthly | `npm update` in `agenda-scraper/` (aws-sdk 3.1127 → 3.1149; 3.1150 declares an unpublished dependency and will not resolve). `npm audit fix` in `site/` (liquidjs 10.30, markdown-it 14.3.2, brace-expansion; Eleventy 3.1.6) and `scripts/` (brace-expansion). Audits: scraper 0, scripts 0, site 2 accepted (see maintenance/README.md → accepted residue). yt-dlp 2026.8.19 current. Nightly 10 of 10 green. 45 change-notice issues open (#42–#87), never triaged: bulk close pending. |
| 2026-10-12 | Quarterly | Root `.venv`: anyio, certifi, idna, pip minors; reconcile manifests for 2934/2935/2936 identical apart from `generatedAt`. Transcript venv held (57 outdated incl. torch, transformers; bgutil-ytdlp-pot-provider 1.3.1 → 2.0.2 waits for a verified archive run). Node 26.1.0 local; pins are major-only. Majors shipped: `better-sqlite3` 13 (`site/` + `scripts/`), `dotenv` 18 (`agenda-scraper/`). `pdf-parse` 2 and the `axios-cookiejar-support` 7 + `tough-cookie` 6 pair stay on the backlog with a re-scrape recipe. wrangler 4.149.0, OAuth login valid. quarterly.md: phantom `agenda-scraper/venv` line removed. |
| 2026-10-12 | Annual | Node 26 pinned everywhere; Active LTS from 2026-10-28 (table corrected: Active LTS to Oct 2027, Maintenance to Apr 2029). Python 3.13.15 everywhere, security-only since 2026-10-01, staying until the April review with toolshed. CI actions on current majors. Dependabot alerts disabled: enabling pending. `gh` scopes gist, read:org, repo. R2 token rotation pending. Pack 56.3 MiB. Secret scan: no values in tracked code; a Mapbox public `pk.` token sits in 26 retired `agenda-scraper/agendas/*.wp.html` files (WordPress output, untouched since 2026-07-15): confirm its URL restriction or remove the files. `.env`, `agenda-scraper/.env`, `data/meetings.db` confirmed ignored. |
| 2026-10-28 | Merge + security | The 10/12 branches merged: `chore/maintenance-2026-10`, `chore/nightly-issue-hygiene`, `chore/scraper-majors` (tough-cookie 6, axios-cookiejar-support 7). `feat/pdf-parse-2` held at Michael's call. Node 26.13.0 local (LTS today; carries the 10/21 security release); the eMudhra intermediate blocklist (nodejs/node#66871) is in no 26.x release yet, CI floats to it when it ships. `npm audit fix`: scraper follow-redirects 1.16.2 + undici 7.30.1, site markdown-it 14.3.3. certifi 2026.10.23 + pip 26.2.2 in root `.venv` (2936 reconcile identical apart from `generatedAt`) and the transcript venv (ML stack still held). `parse-calendar.js` no longer disables TLS verification (D15; live OnBase fetch verified). 54 superseded notices closed (#42–#96); Dependabot alerts enabled, 0 open. Both venv certifi bundles carry neither eMudhra root. The Mapbox `pk.` token in the retired `.wp.html` files (10/12 finding) is a public token: judged benign, no action. Gate: 10/15 re-scrape `--skip-mirror --no-sync` byte-identical JSON, tm-static post unchanged; `npm test` 183, site 42, pytest 102, opengov 6. |
| 2026-10-28 | Monthly (Nov, early) | `npm update`: aws-sdk 3.1159, axios 1.21.0, dotenv 18.0.9, Eleventy 3.1.7 (now chokidar 4: the `braces` and `sprintf-js` residue is gone). Audits 0 / 0 / 0. yt-dlp 2026.8.19 → 2026.10.26 (bgutil 1.3.1 provider loads; simulate picks audio format 251). glob 14 (`scripts/`) and pdf-parse 2 are majors, deferred. `allowScripts` added (see Node rules). Next monthly 2026-12-07. |

---

## Upgrade Checklist (Node.js major bump)

1. `nvm install <version> && nvm alias default <version>`
2. Update `.nvmrc` to new major
3. Update `node-version` in `.github/workflows/nightly-scrape.yml`
4. Update `README.md` prerequisites line
5. Update the Node table at the top of this file
6. Run `npm ci` in `agenda-scraper/`, `site/`, `scripts/` and verify no breakage
7. Commit: `chore: upgrade to Node <version>`

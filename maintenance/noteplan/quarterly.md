---
title: Meetings Quarterly Deps
type: empty-note
---

# Meetings Quarterly Deps — {date}

Jan / Apr / Jul / Oct. ~30 min. Runs *with* that month's monthly checklist.

## Python (four venvs)

- [ ] `.venv/bin/python -m pip list --outdated` (root — httpx stack)
- [ ] `opengov/.venv/bin/python -m pip list --outdated`
- [ ] `agenda-scraper/venv/bin/python -m pip list --outdated`
- [ ] `transcript-cleaner/processor/venv/bin/python -m pip list --outdated`
      — ML deps (gliner, whisper, torch): read changelogs, upgrade only with
      a transcript run to verify

## Node

- [ ] `nvm ls-remote 26 | tail -5` — newer 26.x patch? Update `.nvmrc` *and*
      `node-version` in `.github/workflows/nightly-scrape.yml` together

## Majors watch (changelogs, not auto-bumps)

- [ ] `@11ty/eleventy` minor/major released? Breaking changes common
- [ ] `@llamaindex/liteparse` — active development, core PDF path
- [ ] Major-version backlog review: maintenance/README.md → "Major-version
      backlog" (liteparse 2.x, pdf-parse 2.x, axios-cookiejar-support 7,
      tough-cookie 6)

## Cloudflare

- [ ] Wrangler still authed and current? `npx wrangler@latest whoami`

## Notes

-

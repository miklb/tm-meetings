---
title: Meetings Monthly Maintenance
type: empty-note
---

# Meetings Monthly Maintenance — {date}

~20 min, first Monday. Runbook details: MAINTENANCE.md → "Chore Schedule".

## npm (three package dirs)

- [ ] `cd agenda-scraper && npm outdated` — apply patch/minor; `npm audit`
      (keep the `pdf2json: ^4` override in package.json — see
      maintenance/README.md major-version backlog)
- [ ] `cd site && npm outdated` — apply patch/minor; `npm audit`
- [ ] `cd scripts && npm outdated` — apply patch/minor; `npm audit`
- [ ] If anything bumped: `cd site && npm run build` still passes

## Transcript venv

- [ ] `yt-dlp` upgrade (releases often):
      `transcript-cleaner/processor/venv/bin/python -m pip install -U yt-dlp`

## Repo health

- [ ] `gh run list -L 30` — any pattern of intermittent scrape failures?
- [ ] Open issues triage: `gh issue list`

## Notes

-

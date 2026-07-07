---
title: Meetings Weekly Ops
type: empty-note
---

# Meetings Weekly Ops — {date}

~10 min. Less data-loss-sensitive than toolshed's TPD window, but a dead
scraper means stale published records with no signal.

## Scrape green

- [ ] `gh run list -w nightly-scrape.yml -L 7` — nightly runs succeeded this week
- [ ] Change-detection issues triaged: `gh issue list` — any agenda-change
      issues opened this week reviewed/closed?
- [ ] `git pull --ff-only` locally (bot commits land on main nightly)

## Publish if due

- [ ] New meetings landed this week? Rebuild + deploy:
      `npm run deploy` (repo root — builds and pushes to Pages project
      `tampa-meetings`)
- [ ] Spot-check the live site shows the latest meeting

## Notes

-

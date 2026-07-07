---
title: Meetings Annual Audit
type: empty-note
---

# Meetings Annual Audit — {date}

October (aligns with Node LTS activation). ~1–2 hr. Run alongside the
toolshed annual audit — the Node/Python decisions are shared
(toolshed/maintenance/UNIFIED-PLAN.md).

## Node LTS

- [ ] New Node major in Active LTS? Follow MAINTENANCE.md → "Upgrade
      Checklist (Node.js major bump)" (touches `.nvmrc`,
      `nightly-scrape.yml`, README, copilot-instructions,
      global.instructions, memory)

## Python target

- [ ] Still on a current, well-supported 3.x? Re-align `.python-version`
      and rebuild venvs with toolshed if a new target is picked

## Dependency EOL / CVE sweep

- [ ] `npm audit` in all three package dirs — zero findings?
- [ ] GitHub → Security tab: Dependabot alerts enabled and empty?
- [ ] Any EOL'd majors in the inventory (MAINTENANCE.md tables)?

## Credentials & access

- [ ] Rotate the R2 token used by `@aws-sdk/client-s3` document mirroring
- [ ] `gh auth status` — token scopes still minimal?
- [ ] Cloudflare Pages / API token expiry check

## Data hygiene

- [ ] Repo size check: `git count-objects -vH` — pack growth acceptable?
- [ ] Quick secret scan: `git grep -iE 'api[_-]?key|token|secret' -- ':!*.md'`

## Notes

-

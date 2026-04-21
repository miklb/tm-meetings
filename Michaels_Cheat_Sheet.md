# Michael's Cheat Sheet

Two top-level npm scripts drive everything. Both accept a date like `2026-04-16`.

| Command                         | When                   | What it does                                                                      |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `npm run agenda -- YYYY-MM-DD`  | Friday (pre-meeting)   | Scrape agenda from Hyland → mirror PDFs to R2 → generate `*.wp.html`              |
| `npm run archive -- YYYY-MM-DD` | Tuesday (post-meeting) | Scrape transcript → capitalize → match YouTube video + offset → rebuild DB + site |

Note the `--` separator: without it npm swallows the args.

## Friday — Agenda prep

```bash
git pull
npm run agenda -- YYYY-MM-DD                  # convert + mirror using existing JSON (no re-scrape)
npm run agenda -- YYYY-MM-DD --force          # re-scrape, then convert + mirror
npm run agenda -- YYYY-MM-DD --skip-mirror    # skip R2 mirroring
```

If a JSON for the date already exists (e.g. from the nightly GH Action), the scrape step is skipped. Use `--force` to re-scrape anyway.

Output: `agenda-scraper/agendas/agenda_YYYY-MM-DD.wp.html` plus mirrored PDFs on R2.

## Tuesday — Archive the meeting

```bash
npm run archive -- YYYY-MM-DD
npm run deploy
```

Options:

```bash
npm run archive -- YYYY-MM-DD --skip-video          # no YouTube match / offset
npm run archive -- YYYY-MM-DD --skip-site           # no DB + site rebuild
npm run archive -- YYYY-MM-DD --meeting-type CRA    # override auto-detection
npm run archive -- YYYY-MM-DD --dry-run             # show what would run
```

## Rebuild only

If you fixed data by hand and just need to republish:

```bash
npm run build-db        # rebuild SQLite (scripts/build-db.js)
npm run build-site      # Eleventy build
npm run deploy          # wrangler pages deploy site/_site --project-name tampa-meetings
```

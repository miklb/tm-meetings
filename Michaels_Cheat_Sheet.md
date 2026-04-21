# Michael's Cheat Sheet

The documentation is a bit verbose as there are a lot of moving parts and edge cases to handle, especially during development and debugging. This document is for distilling some of it down for standard workflow reference and to shape future documentation.

## On Friday's

After `git pull`, run:

```bash
npm run process -- YYYY-MM-DD            # convert + mirror using existing JSON (no re-scrape) note the space between flag and date
npm run process -- YYYY-MM-DD --force    # re-scrape, then convert + mirror
npm run process -- YYYY-MM-DD --skip-mirror  # skip R2 mirroring
```

`npm run process` calls `./process-agenda.sh` — they are the same thing. Note the `--` separator; without it npm doesn't pass the args to the script.

By default, if a JSON for the date already exists (e.g. pulled from the nightly GH Action), the scrape step is skipped. Use `--force` to re-scrape anyway.

This grabs the agendas for the date passed (YYYY-MM-DD), generates the file meeting_ID_YYYY_MM_DD.json and mirrors the supporting documents to R2. It also generates the wp.html file.

`node scripts/build-db.js` rebuilds the db

`cd site && npx @11ty/eleventy` rebuild the static site
`wrangler pages deploy site/_site --project-name tampa-meetings`

## On Tuesday:

```bash
./pipeline/process-meeting.sh 2026-03-26
```

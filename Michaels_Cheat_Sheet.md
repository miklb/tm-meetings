# Michael's Cheat Sheet

The documentation is a bit verbose as there are a lot of moving parts and edge cases to handle, especially during development and debugging. This document is for distilling some of it down for standard workflow reference and to shape future documentation.

## Weekly Recurring Checklist

Use this section as your running weekly tracker. Duplicate this block each week.

### Week Of: YYYY-MM-DD

#### 1. Agenda Processing

- [ ] Pull latest changes (`git pull`)
- [ ] Process agenda date(s): `npm run process -- YYYY-MM-DD`
- [ ] Re-scrape if needed: `npm run process -- YYYY-MM-DD --force`
- [ ] Skip mirror run when appropriate: `npm run process -- YYYY-MM-DD --skip-mirror`
- [ ] Confirm JSON and `.wp.html` output were generated for each target date

#### 2. Data + Database

- [ ] Rebuild database: `node scripts/build-db.js`
- [ ] Spot-check updated records in outputs that changed this week

#### 3. Site Build + Deploy

- [ ] Rebuild static site: `cd site && npx @11ty/eleventy`
- [ ] Deploy pages: `wrangler pages deploy site/_site --project-name tampa-meetings`
- [ ] Quick post-deploy sanity check (current meeting page + map + docs links)

#### 4. Transcript / Pipeline Work

- [ ] Run meeting transcript pipeline when needed: `./pipeline/process-meeting.sh YYYY-MM-DD`
- [ ] Confirm transcript outputs and links for processed meetings

#### 5. Weekly Notes (What Got Done)

- [ ] Key fixes completed:
- [ ] Meetings/dates processed:
- [ ] Deploys made:
- [ ] Follow-ups for next week:

---

## Command Notes

`npm run process` calls `./process-agenda.sh` (same behavior).

Use the `--` separator so npm passes args to the script.

By default, if JSON for a date already exists (for example from nightly GitHub Actions), scrape is skipped. Use `--force` to re-scrape.

Running process for a date:

- grabs agendas for `YYYY-MM-DD`
- generates `meeting_ID_YYYY_MM_DD.json`
- mirrors supporting documents to R2 (unless `--skip-mirror`)
- generates the `.wp.html` file

# Michael's Cheat Sheet

The documentation is a bit verbose as there are a lot of moving parts and edge cases to handle, especially during development and debugging. This document is for distilling some of it down for standard workflow reference and to shape future documentation.

On Friday's

`npm run process --date`

This grabs the agendas for the date passed (YYYY-MM-DD), generates the file meeting_ID_YYYY_MM_DD.json and mirrors the supporting documents to R2. It also generates the wp.html file

`node scripts/build-db.js` rebuilds the db

`cd site && npx @11ty/eleventy` rebuild the static site

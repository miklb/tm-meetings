#!/usr/bin/env node
/* sync-design.js — one-way design-system sync: tm-static → this repo.
 *
 * tm-static (~/Sites/tm-static, the Monitor build home) is the source of truth
 * for the shared design system. This copies the shared CSS files over VERBATIM,
 * so run it whenever tm-static's design layer changes (or before touching the
 * site chrome here). The contract that makes that safe:
 *
 *   - Synced files are pristine copies — never edit them in this repo.
 *   - Meetings-specific deviations live in site/public/css/local.css (the
 *     `local` cascade layer, above `components`): the sans body font, the
 *     legacy --color- and --spacing- aliases that keep style.css working.
 *
 * Usage:
 *   npm run sync-design            copy anything that drifted
 *   npm run sync-design -- --check report drift without writing (exit 1 if any)
 *   ... --from <path>              tm-static checkout somewhere other than ../tm-static
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// shared files, relative to both roots below
const FILES = [
  "tokens.css",
  "reset.css",
  "base.css",
  "layout.css",
  "utilities.css",
  "components/breadcrumb.css",
  "components/label.css",
  "components/mainnav.css",
  "components/masthead.css",
  "components/section-head.css",
  "components/site-footer.css",
  "components/toolbox.css", // parked (not imported by app.css) — kept fresh for re-hook
  "components/topbar.css",
];

const repoRoot = path.resolve(__dirname, "..");
const destRoot = path.join(repoRoot, "site", "public", "css");

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIdx = args.indexOf("--from");
const srcBase = fromIdx !== -1 ? path.resolve(args[fromIdx + 1]) : path.resolve(repoRoot, "..", "tm-static");
const srcRoot = path.join(srcBase, "src", "assets", "css");

if (!fs.existsSync(srcRoot)) {
  console.error(`source not found: ${srcRoot}\n(point at a tm-static checkout with --from <path>)`);
  process.exit(1);
}

let drifted = 0;
for (const file of FILES) {
  const src = path.join(srcRoot, file);
  const dest = path.join(destRoot, file);
  if (!fs.existsSync(src)) {
    console.error(`missing in tm-static: ${file} (removed there? update FILES)`);
    process.exitCode = 1;
    continue;
  }
  const want = fs.readFileSync(src);
  const have = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (have && want.equals(have)) {
    console.log(`  up-to-date  ${file}`);
    continue;
  }
  drifted++;
  if (check) {
    console.log(`  DRIFTED     ${file}`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
    console.log(`  synced      ${file}${have ? "" : " (new)"}`);
  }
}

if (check && drifted) {
  console.log(`\n${drifted} file(s) drifted from tm-static — run \`npm run sync-design\` to update.`);
  process.exit(1);
}
console.log(drifted ? `\nsynced ${drifted} file(s) from ${srcBase}` : "\neverything in sync");

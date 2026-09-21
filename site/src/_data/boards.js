const fs = require('fs');
const path = require('path');
const { publicHearing } = require('../../lib/board-hearings.js');

// Land use board hearings, read straight from the collector's JSON (no DB).
// Everything a template sees has been through publicHearing(), the privacy
// boundary in site/lib/board-hearings.js; templates never get the raw files.
const VRB_DIR = path.resolve(__dirname, '..', '..', '..', 'agenda-scraper', 'data', 'vrb');

module.exports = function () {
  const files = fs.existsSync(VRB_DIR)
    ? fs.readdirSync(VRB_DIR).filter((f) => /^vrb_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];

  const hearings = files
    .map((f) => publicHearing(JSON.parse(fs.readFileSync(path.join(VRB_DIR, f), 'utf8'))))
    .sort((a, b) => b.date.localeCompare(a.date));

  return { vrb: { hearings } };
};

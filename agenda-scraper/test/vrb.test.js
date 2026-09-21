// Tests for the Variance Review Board collector's pure logic — run with
// `npm test`. Fixtures under fixtures/vrb/ are pdf-parse output from real
// agendas; nothing here touches tampa.gov, R2, or the data/ directory.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  parseVrbAgenda, parseHeader, resolveHearingDate, splitAssociations, hasStreetAddress, redactWithheldText,
} = require('../lib/vrb-parser');
const { parseListing, isPaginated, parseDocumentPage } = require('../lib/tampa-gov-documents');
const { rebuildHearing, newHearing } = require('../vrb-scraper');
const { accelaRecordId, isLocatable, parseRecord, matchCase } = require('../lib/dev-coord');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'vrb', `${name}.txt`), 'utf8');

// ---------------------------------------------------------------------------
// Agenda parser
// ---------------------------------------------------------------------------

test('May 2026 agenda: header, every case, every field', () => {
  const agenda = parseVrbAgenda(fixture('vrb-agenda-may-2026-189571'));
  assert.equal(agenda.hearingDate, '2026-05-12');
  assert.equal(agenda.hearingTime, '5:30 PM');
  assert.match(agenda.location, /^Old City Hall, 315 E\. Kennedy Boulevard/);
  assert.deepEqual(agenda.warnings, []);
  assert.deepEqual(agenda.cases.map((c) => c.itemNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  assert.deepEqual(agenda.cases[0], {
    itemNumber: 1,
    caseNumber: 'VRB-26-28',
    note: 'Continued from April 14, Hearing',
    section: null,
    ownerApplicant: 'Kevin James and Jessica Lane Bexley/Mark Blanar',
    location: '4510 S Ferncroft Circle',
    folio: '120606.0000',
    zoning: 'Residential Single Family (RS-75)',
    request: 'Reduce rear yard setback from 20 feet to 5 feet',
    codeSection: '27-156',
    neighborhoodAssociationsRaw: 'Culbreath Bayou Homeowners Association Inc.',
    locationWithheld: false,
    owner: 'Kevin James and Jessica Lane Bexley',
    applicant: 'Mark Blanar',
    neighborhoodAssociations: ['Culbreath Bayou Homeowners Association Inc.'],
  });
});

test('a case split by a page break keeps its fields, and the page number is dropped', () => {
  // VRB-26-11: Zoning ends page 2, "3" is the page number, Request opens page 3.
  const c = parseVrbAgenda(fixture('vrb-agenda-may-2026-189571')).cases[2];
  assert.equal(c.caseNumber, 'VRB-26-11');
  assert.equal(c.zoning, 'Residential Single Family (RS-50)');
  assert.match(c.request, /^1\. Request to reduce the required setbacks/);
  assert.equal(c.request.split('\n').length, 2, 'numbered sub-requests stay on their own lines');
  assert.equal(c.codeSection, '27-290');
});

test('notes in parentheses survive stray spaces; an owner with no agent has no applicant', () => {
  const { cases } = parseVrbAgenda(fixture('vrb-agenda-may-2026-189571'));
  assert.equal(cases[3].note, 'Mis-notice'); // source: "( Mis-notice)"
  assert.equal(cases[5].owner, 'Mark Robery Flom');
  assert.equal(cases[5].applicant, null);
});

test('July 2026 agenda: superscript ordinal in the date, section headings', () => {
  const agenda = parseVrbAgenda(fixture('vrb-agenda-july-2026-192481'));
  assert.equal(agenda.hearingDate, '2026-07-14'); // "July 14" / "th" / ", 2026" on three lines
  assert.deepEqual(agenda.warnings, []);
  assert.equal(agenda.cases.length, 12);
  assert.equal(agenda.cases[0].section, 'Continued Cases');
  assert.equal(agenda.cases[1].section, 'New Business');
  // The heading after case 1 must not leak into its association list.
  assert.equal(agenda.cases[0].neighborhoodAssociations.at(-1), 'Armory Gardens Civic Association');
});

test('September 2026 "revised tables" agenda parses like the others', () => {
  const agenda = parseVrbAgenda(fixture('vrb-agenda-sept-2026-194736'));
  assert.equal(agenda.hearingDate, '2026-09-15');
  assert.deepEqual(agenda.warnings, []);
  assert.equal(agenda.cases.length, 12);
  // Label alone on its line, value on the next.
  assert.equal(agenda.cases[1].request,
    'Reduce rear yard setback from 20 feet to 3 feet for a pool greater than 12 inches above grade.');
  assert.match(agenda.cases[1].codeSection, /^Sec\. 27-156 Table 4-2/);
  assert.equal(agenda.cases.at(-1).caseNumber, 'VRB-26-114');
});

test('hand-typed folio variants are kept as typed and not flagged', () => {
  const agenda = parseVrbAgenda(fixture('vrb-agenda-january-2026-178206'));
  assert.deepEqual(agenda.warnings, []);
  assert.deepEqual(agenda.cases.slice(3, 6).map((c) => c.folio), ['12016.0000', '142973-0000', '158277-5000']);
});

test('a case with a missing field is reported, not silently accepted', () => {
  const text = fixture('vrb-agenda-may-2026-189571').replace('Folio: 120606.0000', '');
  assert.deepEqual(parseVrbAgenda(text).warnings, ['VRB-26-28: missing Folio']);
});

test('a new roman-numeral heading before Adjournment ends the last case', () => {
  const text = fixture('vrb-agenda-may-2026-189571').replace(/^VII\.\s+Adjournment/m, 'VII. OTHER BUSINESS\nVIII. Adjournment');
  const last = parseVrbAgenda(text).cases.at(-1);
  assert.equal(last.caseNumber, 'VRB-26-60');
  assert.equal(last.neighborhoodAssociations.at(-1), 'Parkland Estates Civic Club, Inc.');
});

test('splitAssociations keeps ", Inc." with its name and drops exact repeats', () => {
  assert.deepEqual(
    splitAssociations('Beach Park Homeowners Association, Inc.,  Westshore Alliance, Keep Bayshore Beautiful Inc, Westshore Alliance'),
    ['Beach Park Homeowners Association, Inc.', 'Westshore Alliance', 'Keep Bayshore Beautiful Inc']
  );
  assert.deepEqual(splitAssociations(null), []);
});

// ---------------------------------------------------------------------------
// Hearing date
// ---------------------------------------------------------------------------

const MARCH_MINUTES_HEADER = [
  'VARIANCE REVIEW BOARD', 'PUBLIC HEARING',
  'MEETING DATE/TIME: Tuesday, March 13, 2026, at 5:30 PM.',
  'LOCATION: Old City Hall, 315 E. Kennedy Boulevard, City Council Chambers, 3rd Floor,',
  'Tampa, FL 33602', 'Meeting Minutes',
].join('\n');

test('parseHeader reads a minutes header too', () => {
  const header = parseHeader(MARCH_MINUTES_HEADER);
  assert.equal(header.hearingDate, '2026-03-13');
  assert.equal(header.headerWeekday, 'tuesday');
  assert.match(header.location, /Tampa, FL 33602$/);
});

test('resolveHearingDate: a header date on the wrong weekday yields to the title', () => {
  // March 13, 2026 was a Friday; the hearing was Tuesday the 10th.
  const resolved = resolveHearingDate(MARCH_MINUTES_HEADER, 'VRB Minutes - March 10, 2026');
  assert.equal(resolved.hearingDate, '2026-03-10');
  assert.match(resolved.warnings[0], /which is a friday; using 2026-03-10 from the document title/);
});

test('resolveHearingDate: a consistent header wins; a title that does not help changes nothing', () => {
  assert.deepEqual(
    resolveHearingDate(fixture('vrb-agenda-may-2026-189571'), 'VRB Agenda - May 2026'),
    { hearingDate: '2026-05-12', warnings: [] }
  );
  const stuck = resolveHearingDate(MARCH_MINUTES_HEADER, 'VRB Minutes - March 2026');
  assert.equal(stuck.hearingDate, '2026-03-13');
  assert.match(stuck.warnings[0], /no better date found/);
});

// ---------------------------------------------------------------------------
// tampa.gov listing and document pages
// ---------------------------------------------------------------------------

const LISTING_HTML = `
<nav><a href="/document/some-unrelated-form-12345">A form in the menu</a></nav>
<table><thead><tr><th>Title</th><th>Date</th></tr></thead><tbody>
  <tr>
    <td class="views-field views-field-title"><a href="/document/vrb-agenda-sept-2026-194736" hreflang="en">VRB Agenda - Sept 2026</a></td>
    <td class="views-field views-field-field-document-date"><time datetime="2026-09-09T12:00:00Z" class="datetime">2026-09-09</time></td>
  </tr>
  <tr>
    <td class="views-field views-field-title"><a href="/document/vrb-agenda-january-2026-updated-1-12-2026-178936" hreflang="en">VRB Agenda - January 2026
      Updated 1-12-2026</a></td>
    <td class="views-field views-field-field-document-date"><time datetime="2026-01-12T12:00:00Z" class="datetime">2026-01-12</time></td>
  </tr>
</tbody></table>`;

test('parseListing reads the view table only', () => {
  assert.deepEqual(parseListing(LISTING_HTML), [
    {
      slug: 'vrb-agenda-sept-2026-194736',
      nodeId: 194736,
      title: 'VRB Agenda - Sept 2026',
      documentUrl: 'https://www.tampa.gov/document/vrb-agenda-sept-2026-194736',
      postedDate: '2026-09-09',
    },
    {
      slug: 'vrb-agenda-january-2026-updated-1-12-2026-178936',
      nodeId: 178936,
      title: 'VRB Agenda - January 2026 Updated 1-12-2026',
      documentUrl: 'https://www.tampa.gov/document/vrb-agenda-january-2026-updated-1-12-2026-178936',
      postedDate: '2026-01-12',
    },
  ]);
  assert.deepEqual(parseListing('<html><body>Access denied</body></html>'), []);
});

test('isPaginated notices a Drupal pager', () => {
  assert.equal(isPaginated(LISTING_HTML), false);
  assert.equal(isPaginated(`${LISTING_HTML}<nav class="pager"><ul><li class="pager__item pager__item--next"><a href="?page=1">Next</a></li></ul></nav>`), true);
});

test('the latest agenda is chosen by node id, not by the hand-typed posted date', () => {
  // January 2026 as the City published it: both agendas dated 2026-03-10. Here
  // the original is even dated later than the update, and must still lose.
  const hearing = {
    ...newHearing('2026-01-13'),
    documents: [
      { kind: 'agenda', slug: 'updated', nodeId: 178936, postedDate: '2026-01-12' },
      { kind: 'minutes', slug: 'minutes', nodeId: 179999, postedDate: '2026-02-01' },
      { kind: 'agenda', slug: 'original', nodeId: 178206, postedDate: '2026-03-10' },
    ],
  };
  const rebuilt = rebuildHearing(hearing); // no stored text for these slugs
  assert.equal(rebuilt.canonicalAgenda, 'updated');
  assert.deepEqual(rebuilt.documents.map((d) => d.slug), ['original', 'updated', 'minutes']);
  assert.match(rebuilt.warnings[0], /Stored text for updated is missing/);
});

test('parseDocumentPage finds the PDF, the posted date and the updated time', () => {
  const html = `
    <head><meta property="og:updated_time" content="2026-09-09T08:36:54-04:00" /></head>
    <h1 class="title"><span>VRB Agenda - Sept 2026</span></h1>
    <a href="/some/other.pdf">not the document</a>
    <a href="https://www.tampa.gov/sites/default/files/document/2026/vrb-agenda-sept-2026-revised-tables.pdf" download>Download</a>
    <div class="field field--name-field-document-date"><div class="field__item"><time datetime="2026-09-09T12:00:00Z">09/09/2026</time></div></div>`;
  assert.deepEqual(parseDocumentPage(html), {
    title: 'VRB Agenda - Sept 2026',
    pdfUrl: 'https://www.tampa.gov/sites/default/files/document/2026/vrb-agenda-sept-2026-revised-tables.pdf',
    postedDate: '2026-09-09',
    updatedTime: '2026-09-09T08:36:54-04:00',
  });
  assert.equal(parseDocumentPage('<h1>Gone</h1>').pdfUrl, null);
});

// ---------------------------------------------------------------------------
// dev-coord feed join
// ---------------------------------------------------------------------------

const FEED_ROW = {
  RECORDID: 'VRB-26-0000013',
  ADDRESS: '3000 E Busch Blvd',
  NEIGHBORHOOD: 'Terrace Park',
  COUNCILDISTRICT: '7',
  URL: 'https://aca-prod.accela.com/TAMPA/Cap/CapDetail.aspx?capID3=00001',
  geometry: '{"type": "Point", "coordinates": [-82.42411234567, 28.03298765432]}',
};

test('accelaRecordId pads the sequence to seven digits', () => {
  assert.equal(accelaRecordId('VRB-26-28'), 'VRB-26-0000028');
  assert.equal(accelaRecordId('vrb-26-114'), 'VRB-26-0000114');
  assert.equal(accelaRecordId('not a case'), null);
});

test('parseRecord reads the point as lat/lng and rejects a row without one', () => {
  assert.deepEqual(parseRecord(FEED_ROW), {
    recordId: 'VRB-26-0000013',
    lat: 28.032988,
    lng: -82.424112,
    address: '3000 E Busch Blvd',
    neighborhood: 'Terrace Park',
    councilDistrict: '7',
    accelaUrl: FEED_ROW.URL,
  });
  assert.equal(parseRecord({ ...FEED_ROW, geometry: null }), null);
  assert.equal(parseRecord({ ...FEED_ROW, geometry: 'not json' }), null);
});

test('matchCase: spelling differences locate, a different house number does not', () => {
  const record = parseRecord(FEED_ROW);
  // The agenda really does say "Bush".
  assert.equal(matchCase({ caseNumber: 'VRB-26-13', location: '3000 E Bush Blvd' }, record).geo, record);

  const wrong = matchCase({ caseNumber: 'VRB-26-13', location: '3100 E Busch Blvd' }, record);
  assert.equal(wrong.geo, null);
  assert.match(wrong.warning, /agenda says "3100 E Busch Blvd" but VRB-26-0000013 is "3000 E Busch Blvd"/);

  assert.deepEqual(matchCase({ caseNumber: 'VRB-26-13', location: '3000 E Bush Blvd' }, undefined), { geo: null, warning: null });
});

test('a location the agenda withholds is never located, even when the feed has it', () => {
  // VRB-26-69, July 2026: owner and location are "Confidential" on the agenda;
  // the feed still carries the street address and point.
  const withheld = { caseNumber: 'VRB-26-69', location: 'Confidential' };
  assert.equal(isLocatable(withheld), false);
  assert.deepEqual(matchCase(withheld, parseRecord(FEED_ROW)), { geo: null, warning: null });
});

test('rebuildHearing carries locations forward by case number, but not onto a withheld location', () => {
  const text = fixture('vrb-agenda-july-2026-192481');
  const geo = parseRecord(FEED_ROW);
  const hearing = {
    ...newHearing('2026-07-14'),
    documents: [{ kind: 'agenda', slug: 'july', nodeId: 192481 }],
    cases: [
      { caseNumber: 'VRB-26-24', geo },
      { caseNumber: 'VRB-26-69', geo }, // as if an earlier version had located it
    ],
  };
  const rebuilt = rebuildHearing(hearing, () => text);

  assert.equal(rebuilt.cases.find((c) => c.caseNumber === 'VRB-26-24').geo, geo);
  const withheld = rebuilt.cases.find((c) => c.caseNumber === 'VRB-26-69');
  assert.equal(withheld.location, 'Confidential');
  assert.equal(withheld.geo, null);
  assert.ok(rebuilt.warnings.some((w) => /VRB-26-69: agenda gives no street address/.test(w)));
  assert.equal(rebuilt.cases.filter((c) => c.geo).length, 1);
});

// ---------------------------------------------------------------------------
// Withheld locations
// ---------------------------------------------------------------------------

// The July 2026 fixture is stored redacted, as everything under data/vrb/text
// is. To test redaction, put a made-up folio back where the City printed one.
const FAKE_FOLIO = '999999.0000';
const julyAsPublished = () => fixture('vrb-agenda-july-2026-192481').replace('Folio: [withheld]', `Folio: ${FAKE_FOLIO}`);

test('hasStreetAddress: a house number, or the location counts as withheld', () => {
  assert.equal(hasStreetAddress('4510 S Ferncroft Circle'), true);
  assert.equal(hasStreetAddress('Confidential'), false);
  assert.equal(hasStreetAddress('Exempt per F.S. 119.071'), false);
  assert.equal(hasStreetAddress(null), false);
});

test('a withheld case loses its folio and is flagged, without a missing-field warning', () => {
  const agenda = parseVrbAgenda(julyAsPublished());
  const c = agenda.cases.find((x) => x.caseNumber === 'VRB-26-69');
  assert.equal(c.location, 'Confidential');
  assert.equal(c.locationWithheld, true);
  assert.equal(c.folio, null);
  assert.deepEqual(agenda.warnings, []);
  assert.equal(agenda.cases.filter((x) => x.locationWithheld).length, 1);
  assert.ok(!JSON.stringify(agenda).includes(FAKE_FOLIO));
});

test('redactWithheldText blanks only the withheld case\'s folio, and is idempotent', () => {
  const published = julyAsPublished();
  const redacted = redactWithheldText(published);
  assert.ok(!redacted.includes(FAKE_FOLIO));
  assert.equal(redacted, fixture('vrb-agenda-july-2026-192481'));
  assert.equal(redactWithheldText(redacted), redacted);
  // Every other folio on the agenda is still there.
  assert.equal(redacted.match(/^Folio: \d/gm).length, 11);
  // An agenda with nothing withheld comes back byte for byte.
  const may = fixture('vrb-agenda-may-2026-189571');
  assert.equal(redactWithheldText(may), may);
});

test('redactWithheldText handles a value on the line after its label, and minutes-style headers', () => {
  const text = [
    'VI. ITEMS TO BE REVIEWED',
    '8.VRB-26-69',
    'Owner/Applicant: Confidential/ASC Aluminum',
    'Location:', '', 'Confidential',
    'Folio:', '4', FAKE_FOLIO, // "4" is a page number between label and value
    'Zoning: Residential Single-Family (RS-60)',
    '9. VRB-26-73',
    'Location: 1806 E Annona Ave',
    'Folio: 144746.0000',
  ].join('\n');
  const redacted = redactWithheldText(text);
  assert.ok(!redacted.includes(FAKE_FOLIO));
  assert.ok(redacted.includes('Folio: 144746.0000'));
  assert.equal(parseVrbAgenda(redacted).cases[0].folio, null);
});

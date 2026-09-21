// The privacy boundary for land use board pages: collected JSON → page model.
// Run: npm test (root) or node --test site/test/board-hearings.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicHearing, caseItemId } from '../lib/board-hearings.js';

const GEO = {
  recordId: 'VRB-26-0000024', lat: 27.942144, lng: -82.528493, address: '5102 W Platt St',
  neighborhood: 'Beach Park', councilDistrict: '6', accelaUrl: 'https://aca-prod.accela.com/TAMPA/x',
};

// Shaped like agenda-scraper/data/vrb/vrb_<date>.json; the people are invented.
const RAW = {
  board: 'vrb',
  boardName: 'Variance Review Board',
  hearingDate: '2026-07-14',
  hearingTime: '5:30 PM',
  location: 'Old City Hall, 315 E. Kennedy Boulevard',
  canonicalAgenda: 'agenda-updated-2',
  documents: [
    { kind: 'agenda', slug: 'agenda-1', title: 'VRB Agenda', documentUrl: 'https://www.tampa.gov/document/agenda-1', pdfUrl: 'https://www.tampa.gov/a1.pdf', mirroredUrl: null },
    { kind: 'agenda', slug: 'agenda-updated-2', title: 'VRB Agenda Updated', documentUrl: 'https://www.tampa.gov/document/agenda-updated-2', pdfUrl: 'https://www.tampa.gov/a2.pdf', mirroredUrl: 'https://docs.example/a2.pdf', pages: 7 },
    { kind: 'minutes', slug: 'minutes-3', title: 'VRB Minutes', documentUrl: 'https://www.tampa.gov/document/minutes-3', pdfUrl: 'https://www.tampa.gov/m3.pdf', mirroredUrl: null },
  ],
  cases: [
    {
      itemNumber: 1, caseNumber: 'VRB-26-24', note: null, section: 'Continued Cases',
      ownerApplicant: 'Pat Example and Sam Example/Example Permits LLC', owner: 'Pat Example and Sam Example', applicant: 'Example Permits LLC',
      location: '5102 W Platt St', folio: '113358.0000', zoning: 'Residential Single-Family (RS-75)',
      request: '1. Reduce side yard setback from 7 feet to 3 feet\n2. Reduce rear yard setback from 20 feet to 3 feet.',
      codeSection: '27-156', neighborhoodAssociations: ['Beach Park Homeowners Association, Inc.'],
      neighborhoodAssociationsRaw: 'Beach Park Homeowners Association, Inc.', locationWithheld: false, geo: GEO,
    },
    {
      itemNumber: 2, caseNumber: 'VRB-26-69', note: null, section: 'New Business',
      ownerApplicant: 'Confidential/Example Aluminum', owner: 'Confidential', applicant: 'Example Aluminum',
      location: 'Confidential', folio: '999999.0000', zoning: 'Residential Single-Family (RS-60)',
      request: 'Reduce front yard setback from 25’ to 6’', codeSection: '27-156',
      neighborhoodAssociations: ['Forest Hills Neighborhood Association, Inc'],
      // As if an old collector had produced this file: no flag, and a location attached.
      geo: { ...GEO, address: '1 Secret St', lat: 28.05, lng: -82.49 },
    },
  ],
};

test('a case is its address and its request: no names, no folio, anywhere in the model', () => {
  const model = publicHearing(RAW);
  const flat = JSON.stringify(model);
  for (const secret of ['Pat Example', 'Sam Example', 'Example Permits', 'Example Aluminum', '113358', '999999']) {
    assert.ok(!flat.includes(secret), `model leaks "${secret}"`);
  }
  assert.deepEqual(Object.keys(model.cases[0]).sort(), [
    'accelaUrl', 'address', 'associations', 'caseNumber', 'codeSection', 'councilDistrict', 'id',
    'itemNumber', 'lat', 'lng', 'neighborhood', 'note', 'requests', 'section', 'withheld', 'zoning',
  ]);
});

test('a located case carries its point, neighborhood and permit link; numbered requests become a list', () => {
  const c = publicHearing(RAW).cases[0];
  assert.equal(c.address, '5102 W Platt St');
  assert.equal(c.withheld, false);
  assert.deepEqual([c.lat, c.lng, c.neighborhood, c.councilDistrict], [27.942144, -82.528493, 'Beach Park', '6']);
  assert.equal(c.accelaUrl, GEO.accelaUrl);
  assert.deepEqual(c.requests, [
    'Reduce side yard setback from 7 feet to 3 feet',
    'Reduce rear yard setback from 20 feet to 3 feet.',
  ]);
});

test('a withheld location yields no address, point or permit link, even if the data carries them', () => {
  const c = publicHearing(RAW).cases[1];
  assert.equal(c.withheld, true);
  assert.deepEqual([c.address, c.lat, c.lng, c.accelaUrl, c.neighborhood, c.councilDistrict], [null, null, null, null, null, null]);
  assert.deepEqual(c.requests, ['Reduce front yard setback from 25’ to 6’']);
  assert.ok(!JSON.stringify(c).includes('Secret St'));
});

test('documents: the canonical agenda, earlier versions and minutes, each with the City page and the archived copy', () => {
  const model = publicHearing(RAW);
  assert.equal(model.url, '/boards/vrb/2026-07-14/');
  assert.deepEqual(model.agenda, {
    title: 'VRB Agenda Updated', cityPage: 'https://www.tampa.gov/document/agenda-updated-2',
    cityPdf: 'https://www.tampa.gov/a2.pdf', archivedPdf: 'https://docs.example/a2.pdf', pages: 7,
  });
  assert.deepEqual(model.earlierAgendas.map((d) => d.title), ['VRB Agenda']);
  assert.deepEqual(model.minutes.map((d) => d.title), ['VRB Minutes']);
});

test('caseItemId is per hearing, so a continued case is a new item at its next hearing', () => {
  assert.equal(caseItemId('2026-07-14', 'VRB-26-24'), 'vrb-26-24-2026-07-14');
  assert.notEqual(caseItemId('2026-06-16', 'VRB-26-24'), caseItemId('2026-07-14', 'VRB-26-24'));
});

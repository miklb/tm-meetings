// Hard-coded map locations for council agenda posts — run with `npm test`.
// Pure logic only: nothing here touches the dev-coord feed or data/.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { padFileNumber, mapRecordId, recordsToLocate, mergeLocations } = require('../lib/record-locations');
const { parseRecord, inCityBounds } = require('../lib/dev-coord');
const { collectMapData } = require('../json-to-markdown');

const ITEMS = [
  { number: '1', agendaItemId: 101, fileNumber: 'CM26-1234' },                       // not a land use record
  { number: '8', agendaItemId: 108, fileNumber: 'AB2-26-10' },                       // in the feed
  { number: '9', agendaItemId: 109, fileNumber: 'REZ-26-45', folioNumbers: ['183367.0000'] },
  { number: '10', agendaItemId: 110, fileNumber: 'SU1-26-7', coordinates: { lat: 27.95, lng: -82.45 } }, // scraper geocoded it
  { number: '11', agendaItemId: 111, fileNumber: 'AB2-26-17' },                      // never located
];

const FOUND = new Map([
  ['AB2-26-0000010', { recordId: 'AB2-26-0000010', lat: 28.003455, lng: -82.459403, address: '6203 N Florida Ave', neighborhood: 'Seminole Heights', councilDistrict: '6', accelaUrl: 'https://aca-prod.accela.com/TAMPA/x?a=1&b=2' }],
  ['REZ-26-0000045', { recordId: 'REZ-26-0000045', lat: 27.965866, lng: -82.467944, address: "100 O'Brien St", neighborhood: null, councilDistrict: '4', accelaUrl: 'https://aca-prod.accela.com/TAMPA/y' }],
]);

test('recordsToLocate: land use records the scraper did not geocode, minus what is stored', () => {
  assert.deepEqual(recordsToLocate(ITEMS, {}), ['AB2-26-0000010', 'REZ-26-0000045', 'AB2-26-0000017']);
  assert.deepEqual(recordsToLocate(ITEMS, { 'AB2-26-0000010': {} }), ['REZ-26-0000045', 'AB2-26-0000017']);
  assert.equal(padFileNumber('TA/CPA'), 'TA/CPA');
});

test('mergeLocations only ever adds: a stored location survives the record leaving the feed', () => {
  const first = mergeLocations({}, FOUND, '2026-09-21');
  assert.deepEqual(first.added, ['AB2-26-0000010', 'REZ-26-0000045']);
  assert.equal(first.records['AB2-26-0000010'].locatedOn, '2026-09-21');

  // Weeks later the feed returns nothing, or a moved point: nothing changes.
  const moved = new Map([['AB2-26-0000010', { ...FOUND.get('AB2-26-0000010'), lat: 1, lng: 1 }]]);
  for (const found of [new Map(), moved]) {
    const later = mergeLocations(first.records, found, '2026-11-01');
    assert.deepEqual(later.added, []);
    assert.deepEqual(later.records, first.records);
  }
});

test('collectMapData: stored locations become explicit pins with popup details; the rest stay on the live lookup', () => {
  const { records } = mergeLocations({}, FOUND, '2026-09-21');
  const { html } = collectMapData(ITEMS, records);
  const attr = (name) => html.match(new RegExp(`data-${name}="([^"]*)"`))[1];

  // every mappable item is still in data-records, located or not
  assert.equal(attr('records'), 'AB2-26-0000010:8, REZ-26-0000045:9, SU1-26-0000007:10, AB2-26-0000017:11');
  assert.equal(attr('folios'), [
    'AB2-26-0000010:28.003455,-82.459403',
    'REZ-26-0000045:27.965866,-82.467944:183367.0000', // keeps its parcel list
    'SU1-26-0000007:27.95,-82.45',                      // the scraper's own geocode wins
  ].join('|'));

  const details = JSON.parse(attr('record-details').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  assert.deepEqual(details, {
    'AB2-26-0000010': { address: '6203 N Florida Ave', url: 'https://aca-prod.accela.com/TAMPA/x?a=1&b=2', permit: true },
    'REZ-26-0000045': { address: "100 O'Brien St", url: 'https://aca-prod.accela.com/TAMPA/y', permit: true },
  });
  assert.ok(!/data-record-details="[^"]*'/.test(html), 'apostrophes are escaped inside the attribute');
});

test('plan amendments typed "TA/CPA 26-05" keep a unique map id, so each pin finds its own item', () => {
  // 9/24/26 evening agenda: the scraper kept only "TA/CPA" for all five.
  const amendments = [
    { number: '3', agendaItemId: 203, fileNumber: 'TA/CPA', rawTitle: 'File No. TA/CPA 26-05\nPublic Hearing on a publicly initiated request', coordinates: { lat: 27.97705, lng: -82.46752 }, folioNumbers: ['182151.5005'] },
    { number: '4', agendaItemId: 204, fileNumber: 'TA/CPA', rawTitle: 'File No. TA/CPA 26-08\nPublic Hearing on a publicly initiated request', coordinates: { lat: 27.999438, lng: -82.404836 } },
    { number: '5', agendaItemId: 205, fileNumber: 'TA/CPA25-19', rawTitle: 'File No. TA/CPA25-19\nContinued Public Hearing', coordinates: { lat: 27.95949, lng: -82.4504 } }, // the usual form, unchanged
    { number: '6', agendaItemId: 206, fileNumber: 'TA/CPA', rawTitle: 'Public Hearing with no case number up front', coordinates: { lat: 27.96, lng: -82.46 } }, // nothing to recover
  ];
  assert.equal(mapRecordId(amendments[0]), 'TA/CPA26-0000005');
  assert.equal(mapRecordId(amendments[2]), 'TA/CPA25-0000019');
  assert.equal(mapRecordId(amendments[3]), 'TA/CPA');

  const { html } = collectMapData(amendments);
  const attr = (name) => html.match(new RegExp(`data-${name}="([^"]*)"`))[1];
  assert.equal(attr('records'), 'TA/CPA26-0000005:3, TA/CPA26-0000008:4, TA/CPA25-0000019:5, TA/CPA:6');
  assert.equal(attr('folios'), [
    'TA/CPA26-0000005:27.97705,-82.46752:182151.5005',
    'TA/CPA26-0000008:27.999438,-82.404836',
    'TA/CPA25-0000019:27.95949,-82.4504',
    'TA/CPA:27.96,-82.46',
  ].join('|'));
});

test('collectMapData with no stored locations is unchanged from before', () => {
  const { html } = collectMapData(ITEMS);
  assert.ok(!html.includes('data-record-details'));
  assert.match(html, /data-folios="REZ-26-0000045:183367\.0000\|SU1-26-0000007:27\.95,-82\.45"/);
});

test('a feed point outside the city is no point at all', () => {
  // AB2-26-0000017, "1601 N Franklin St" downtown, as the City's feed has it.
  const row = { RECORDID: 'AB2-26-0000017', ADDRESS: '1601 N Franklin St', geometry: '{"type":"Point","coordinates":[-82.129898,28.028901]}' };
  assert.equal(parseRecord(row), null);
  assert.equal(inCityBounds(-82.459, 27.957), true);   // where it actually is
  assert.equal(inCityBounds(-82.3266, 28.1408), true); // New Tampa
  assert.equal(inCityBounds(-82.5416, 27.8719), true); // South of Gandy
});

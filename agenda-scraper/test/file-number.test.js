// extractFileNumber — run with `npm test`. Cases are real item headings.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractFileNumber } = require('../json-scraper');
const { mapRecordId } = require('../lib/record-locations');

test('plan amendments: typed with a space or closed up, one file number either way', () => {
  // 9/24/26 evening agenda — all five used to come out as "TA/CPA".
  assert.equal(extractFileNumber('File No. TA/CPA 26-05\nPublic Hearing on a publicly initiated request'), 'TA/CPA26-05');
  assert.equal(extractFileNumber('File No. TA/CPA 25-20 (UNAN)\nAn ordinance being presented for second reading'), 'TA/CPA25-20');
  assert.equal(extractFileNumber('File No. TA/CPA25-19\nContinued Public Hearing'), 'TA/CPA25-19');
  assert.equal(extractFileNumber('TA/CPA25-12 Comprehensive plan amendment'), 'TA/CPA25-12');
  assert.equal(extractFileNumber('File No. TA / CPA 24 - 11'), 'TA/CPA24-11');
});

test('a plan amendment mentioned inside another item does not take over its file number', () => {
  assert.equal(
    extractFileNumber('File No. REZ-26-48\nPublic hearing on a rezoning related to TA/CPA 26-05, generally located at 3043 North Florida Avenue'),
    'REZ-26-48'
  );
});

test('everything else extracts as before', () => {
  assert.equal(extractFileNumber('File No. FDN 25-36-C\nPublic hearing text'), 'FDN 25-36-C');
  assert.equal(extractFileNumber('CM25-12001 Mobility Department to provide a report'), 'CM25-12001');
  assert.equal(extractFileNumber('File No. AB2-26-17\nPublic Hearing on application of 1601 Ybr LLC'), 'AB2-26-17');
  assert.equal(extractFileNumber('REZ-24-15 Rezoning request discussion'), 'REZ-24-15');
  assert.equal(extractFileNumber('Administration Update'), 'Administration Update');
  assert.equal(extractFileNumber(''), null);
});

test('the map id agrees whether the number came from the scraper or was recovered from old data', () => {
  const fresh = { fileNumber: extractFileNumber('File No. TA/CPA 26-05'), rawTitle: 'File No. TA/CPA 26-05' };
  const stale = { fileNumber: 'TA/CPA', rawTitle: 'File No. TA/CPA 26-05' }; // scraped before the fix
  assert.equal(mapRecordId(fresh), 'TA/CPA26-0000005');
  assert.equal(mapRecordId(stale), mapRecordId(fresh));
});

/**
 * Development Coordination feed lookup.
 *
 * dev-coord.tampamonitor.com is a Datasette over the City's Development
 * Coordination applications layer. Every VRB case is an Accela record there,
 * with a point, the City's neighborhood label, the council district and the
 * Accela detail URL. Records move from the `current` view to `archived` once
 * the City closes them, so the lookup is done when a case is collected and the
 * result is stored with the case.
 *
 * Parsing is separate from fetching so it can be tested without the network.
 */

'use strict';

const axios = require('axios');
const { withRetry } = require('./retry');
const { USER_AGENT } = require('./tampa-gov-documents');
const { hasStreetAddress } = require('./vrb-parser');

const FEED = 'https://dev-coord.tampamonitor.com/locations';
const VIEWS = ['current', 'archived'];

/**
 * Agendas print "VRB-26-28"; Accela's id is "VRB-26-0000028".
 * @returns {string|null}
 */
function accelaRecordId(caseNumber) {
  const m = String(caseNumber || '').match(/^([A-Z]+)-(\d{2})-(\d+)$/i);
  return m ? `${m[1].toUpperCase()}-${m[2]}-${m[3].padStart(7, '0')}` : null;
}

/** Leading house number, the one part of an address two typists agree on. */
const houseNumber = (address) => (String(address || '').match(/^\s*(\d+)/) || [])[1] || null;

/**
 * The feed still carries the street address and point of a record whose
 * location the agenda withholds (see hasStreetAddress in lib/vrb-parser.js).
 * Such a case is never looked up and never located.
 */
const isLocatable = (agendaCase) => hasStreetAddress(agendaCase.location);

/**
 * @param {object} row - one Datasette row
 * @returns {object|null} null when the row has no usable point
 */
function parseRecord(row) {
  let point = null;
  try {
    const geometry = typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry;
    if (geometry && geometry.type === 'Point') point = geometry.coordinates;
  } catch (err) {
    point = null;
  }
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;

  return {
    recordId: row.RECORDID,
    lat: Number(point[1].toFixed(6)),
    lng: Number(point[0].toFixed(6)),
    address: row.ADDRESS || null,
    neighborhood: row.NEIGHBORHOOD || null,
    councilDistrict: row.COUNCILDISTRICT || null,
    accelaUrl: row.URL || null,
  };
}

/**
 * Attach a feed record to a case only when the two agree on the house number.
 * Case numbers are typed by hand on the agenda; a wrong pin on a map is worse
 * than no pin.
 * @returns {{geo: object|null, warning: string|null}}
 */
function matchCase(agendaCase, record) {
  if (!isLocatable(agendaCase) || !record) return { geo: null, warning: null };
  const ours = houseNumber(agendaCase.location);
  const theirs = houseNumber(record.address);
  if (ours !== theirs) {
    return {
      geo: null,
      warning: `${agendaCase.caseNumber}: agenda says "${agendaCase.location}" but ${record.recordId} is "${record.address}"; not located`,
    };
  }
  return { geo: record, warning: null };
}

/**
 * @param {string[]} recordIds - Accela ids
 * @returns {Promise<Map<string, object>>} recordId → parsed record
 */
async function fetchRecords(recordIds) {
  const found = new Map();
  for (const view of VIEWS) {
    const missing = recordIds.filter((id) => !found.has(id));
    if (!missing.length) break;
    const response = await withRetry(
      () => axios.get(`${FEED}/${view}.json`, {
        params: { RECORDID__in: missing.join(','), _shape: 'array', _size: 'max' },
        timeout: 60000,
        headers: { 'User-Agent': USER_AGENT },
      }),
      { label: `dev-coord ${view}` }
    );
    for (const row of response.data) {
      const record = parseRecord(row);
      if (record && !found.has(record.recordId)) found.set(record.recordId, record);
    }
  }
  return found;
}

module.exports = { accelaRecordId, isLocatable, parseRecord, matchCase, fetchRecords };

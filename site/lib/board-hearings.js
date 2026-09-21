/**
 * Land use board hearings: collected JSON → what a page may show.
 *
 * This module is the privacy boundary for board pages. The collector's files
 * (agenda-scraper/data/vrb/) keep the agenda as the City typed it, including
 * owner and applicant names. Pages are built only from what publicHearing()
 * returns, and it is an allowlist: a case is its address and its variance
 * request, plus the zoning context and the associations the City notified.
 * No person's name, no folio. An indexed web page that pairs a homeowner's
 * name with their address and a map link is a different thing from the same
 * words inside the City's PDF, which stays one click away.
 *
 * Where the agenda withholds the location ("Confidential", the City's mark
 * for a public-records exemption), the case keeps only its request: no
 * address, no coordinates, no link to the City's permit record.
 */

/** Anchor and notification id for a case at one hearing. A continued case gets
 *  a new id at its next hearing, so it alerts again for the new date. */
export function caseItemId(hearingDate, caseNumber) {
  return `${String(caseNumber).toLowerCase()}-${hearingDate}`;
}

// Checked here as well as by the collector's flag: a page must not depend on
// the data having been produced by a current collector.
const isWithheld = (c) => c.locationWithheld === true || !/^\s*\d/.test(String(c.location || ''));

function publicCase(hearingDate, c) {
  const withheld = isWithheld(c);
  const geo = withheld ? null : c.geo || null;
  const requests = String(c.request || '')
    .split('\n')
    .map((line) => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);

  return {
    id: caseItemId(hearingDate, c.caseNumber),
    itemNumber: c.itemNumber,
    caseNumber: c.caseNumber,
    note: c.note || null,
    section: c.section || null,
    withheld,
    address: withheld ? null : c.location,
    requests,
    zoning: c.zoning || null,
    codeSection: c.codeSection || null,
    associations: c.neighborhoodAssociations || [],
    neighborhood: geo ? geo.neighborhood : null,
    councilDistrict: geo ? geo.councilDistrict : null,
    lat: geo ? geo.lat : null,
    lng: geo ? geo.lng : null,
    accelaUrl: geo ? geo.accelaUrl : null,
  };
}

/**
 * Attribute strings for tm-static's agenda map (bootAgenda in maps.js, synced
 * here by `npm run sync-design`). Every point goes in data-folios as explicit
 * coordinates, the path that never reads the live feed, so a pin cannot drop
 * off when the City archives the record. Ids are the agenda's own case numbers
 * ("VRB-26-24"), which the feed's padded RECORDIDs never equal: the map's feed
 * lookup therefore cannot add a point this function left out. A withheld case
 * is in neither string.
 */
function mapAttributes(cases) {
  const located = cases.filter((c) => !c.withheld && c.lat !== null && c.lng !== null);
  if (!located.length) return null;
  return {
    records: located.map((c) => `${c.caseNumber}:${c.itemNumber}`).join(', '),
    points: located.map((c) => `${c.caseNumber}:${c.lat},${c.lng}`).join('|'),
  };
}

const publicDocument = (d) => ({
  title: d.title,
  cityPage: d.documentUrl,
  cityPdf: d.pdfUrl,
  archivedPdf: d.mirroredUrl || null,
  pages: d.pages || null,
});

/**
 * @param {object} raw - one agenda-scraper/data/vrb/vrb_<date>.json
 * @returns {object} the page model
 */
export function publicHearing(raw) {
  const agendas = raw.documents.filter((d) => d.kind === 'agenda');
  const current = agendas.find((d) => d.slug === raw.canonicalAgenda) || null;
  const cases = (raw.cases || []).map((c) => publicCase(raw.hearingDate, c));

  return {
    board: raw.board,
    boardName: raw.boardName,
    date: raw.hearingDate,
    time: raw.hearingTime || null,
    location: raw.location || null,
    url: `/boards/${raw.board}/${raw.hearingDate}/`,
    agenda: current ? publicDocument(current) : null,
    earlierAgendas: agendas.filter((d) => d !== current).map(publicDocument),
    minutes: raw.documents.filter((d) => d.kind === 'minutes').map(publicDocument),
    cases,
    map: mapAttributes(cases),
  };
}

/**
 * tampa.gov document listings.
 *
 * The land use boards (VRB, ARC, BLC) post agendas on tampa.gov, not OnBase.
 * A listing page is a Drupal view: one table row per document, linking to a
 * document page (/document/<slug>-<node id>), which links to the PDF under
 * /sites/default/files/document/. Two hops, both plain HTML.
 *
 * Parsing is separate from fetching so the parsers can be tested on saved HTML.
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { withRetry } = require('./retry');

const SITE = 'https://www.tampa.gov';
const USER_AGENT = 'tampa-meetings-archive/1.0 (+https://github.com/miklb/tm-meetings)';

/**
 * @param {string} html - a listing page
 * @returns {{slug: string, nodeId: number|null, title: string, documentUrl: string, postedDate: string|null}[]}
 */
function parseListing(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const documents = [];

  // Only the view's table rows: menus and sidebars link to documents too.
  $('table tr a[href^="/document/"]').each((_, a) => {
    const href = $(a).attr('href').split(/[?#]/)[0];
    const slug = href.replace('/document/', '');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);

    const nodeId = slug.match(/-(\d+)$/);
    const posted = $(a).closest('tr').find('time[datetime]').first().attr('datetime');
    documents.push({
      slug,
      nodeId: nodeId ? Number(nodeId[1]) : null,
      title: $(a).text().replace(/\s+/g, ' ').trim(),
      documentUrl: SITE + href,
      postedDate: posted ? posted.slice(0, 10) : null,
    });
  });

  return documents;
}

/**
 * True when the listing view has grown a pager. No board listing had one as of
 * 2026-09-20 (the ARC page shows 29 rows unpaged), so following pages is not
 * built; the caller should say so loudly instead of silently missing documents.
 */
function isPaginated(html) {
  return cheerio.load(html)('.pager__item, nav.pager').length > 0;
}

/**
 * @param {string} html - a /document/<slug> page
 * @returns {{title: string|null, pdfUrl: string|null, postedDate: string|null, updatedTime: string|null}}
 */
function parseDocumentPage(html) {
  const $ = cheerio.load(html);

  const pdfHref = $('a[href$=".pdf" i]')
    .map((_, a) => $(a).attr('href'))
    .get()
    .find((href) => href.includes('/sites/default/files/'));

  const posted = $('.field--name-field-document-date time[datetime]').first().attr('datetime');

  return {
    title: $('h1').first().text().replace(/\s+/g, ' ').trim() || null,
    pdfUrl: pdfHref ? new URL(pdfHref, SITE).href : null,
    postedDate: posted ? posted.slice(0, 10) : null,
    // Drupal bumps this when staff replace the PDF on an existing document
    // page, which is how the September 2026 agenda was revised.
    updatedTime: $('meta[property="og:updated_time"]').attr('content') || null,
  };
}

async function fetchHtml(url) {
  const response = await withRetry(
    () => axios.get(url, { timeout: 60000, headers: { 'User-Agent': USER_AGENT } }),
    { label: url }
  );
  return response.data;
}

async function fetchPdf(url) {
  const response = await withRetry(
    () => axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      headers: { 'User-Agent': USER_AGENT },
    }),
    { label: url }
  );
  const buffer = Buffer.from(response.data);
  // An error page served with a 200 must never be archived as the document.
  if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error(`Not a PDF: ${url}`);
  }
  return buffer;
}

module.exports = { SITE, USER_AGENT, parseListing, isPaginated, parseDocumentPage, fetchHtml, fetchPdf };

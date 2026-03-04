/**
 * HTTP Scraper Utilities
 * Shared helpers for HTTP-based agenda scraping
 */

const BASE_URL = 'https://tampagov.hylandcloud.com';

/**
 * Convert relative or absolute URL to absolute URL
 * @param {string} relativeOrAbsolute - URL to convert
 * @returns {string|null} - Absolute URL or null
 */
function absoluteUrl(relativeOrAbsolute) {
  if (!relativeOrAbsolute) return null;
  if (relativeOrAbsolute.startsWith('http')) return relativeOrAbsolute;
  return BASE_URL + relativeOrAbsolute.replace(/&amp;/g, '&');
}

/**
 * Convert DownloadFile URLs to DownloadFileBytes for direct PDF access
 * @param {string} downloadFileUrl - Original download URL
 * @returns {string} - Direct PDF URL
 */
function convertToDirectPDFUrl(downloadFileUrl) {
  if (!downloadFileUrl) return downloadFileUrl;
  if (downloadFileUrl.includes('DownloadFile') && !downloadFileUrl.includes('DownloadFileBytes')) {
    return downloadFileUrl.replace('DownloadFile', 'DownloadFileBytes');
  }
  return downloadFileUrl;
}

/**
 * Extract meeting date from HTML content
 * @param {string} html - HTML content to parse
 * @returns {string} - Extracted date string or empty string
 */
function extractMeetingDate(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  // Try common selectors first
  const selectors = ['#lblMeetingDate', '.meeting-date', '[id*="date"]', '[class*="date"]'];
  for (const selector of selectors) {
    const text = $(selector).first().text().trim();
    if (text && text.length > 5) return text;
  }

  // Try title tag
  const titleDate = $('title').text().match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2}, \d{4})/);
  if (titleDate) return titleDate[1];

  // Search headers and spans for date patterns
  let found = '';
  $('h1, span').each((_, el) => {
    if (found) return;
    const text = $(el).text().trim();
    const match = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (match) {
      found = match[1];
      return false;
    }
    const numeric = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (numeric) {
      found = numeric[1];
      return false;
    }
  });
  if (found) return found;

  // Try day pattern in raw HTML
  const dayPattern = html.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  if (dayPattern) {
    return dayPattern[1];
  }

  // Try month pattern
  const monthPattern = html.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
  if (monthPattern) {
    return monthPattern[1];
  }

  return '';
}

/**
 * Parse loadAgendaItem function from JavaScript source
 * @param {string} source - JavaScript source code
 * @returns {Object|null} - Parsed configuration or null
 */
function parseLoadAgendaFromSource(source) {
  if (!source || !source.includes('loadAgendaItem')) {
    return null;
  }

  const nameVariants = ['function loadAgendaItem', 'loadAgendaItem = function'];
  let fnSource = null;

  for (const variant of nameVariants) {
    const start = source.indexOf(variant);
    if (start === -1) {
      continue;
    }

    const braceStart = source.indexOf('{', start);
    if (braceStart === -1) {
      continue;
    }

    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      const char = source[i];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          fnSource = source.slice(start, i + 1);
          break;
        }
      }
    }

    if (fnSource) {
      break;
    }
  }

  if (!fnSource) {
    return null;
  }

  const ajaxUrlMatch = fnSource.match(/url\s*:\s*['"]([^'"]+)['"]/i);
  const templateUrlMatch = fnSource.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/i);
  const dataMatch = fnSource.match(/data\s*:\s*\{([\s\S]*?)\}/i);
  const meetingVarMatch = source.match(/var\s+meetingId\s*=\s*(\d+)/i);

  return {
    url: ajaxUrlMatch ? ajaxUrlMatch[1] : null,
    templateUrl: templateUrlMatch ? templateUrlMatch[1] : null,
    method: ajaxUrlMatch ? (fnSource.match(/type\s*:\s*['"]([^'"]+)['"]/i)?.[1].toUpperCase() || 'GET') : 'GET',
    meetingVar: meetingVarMatch ? meetingVarMatch[1] : null,
    rawDataSection: dataMatch ? dataMatch[1] : null,
    rawScript: fnSource
  };
}

/**
 * Extract loadAgendaItem configuration from HTML and external scripts
 * @param {Object} client - Axios client instance
 * @param {string} html - HTML content
 * @returns {Promise<Object|null>} - Configuration object or null
 */
async function extractLoadAgendaConfig(client, html) {
  const cheerio = require('cheerio');
  
  // Try parsing from inline scripts first
  const directConfig = parseLoadAgendaFromSource(html);
  if (directConfig && directConfig.url) {
    return directConfig;
  }
  if (directConfig && directConfig.templateUrl) {
    return directConfig;
  }

  // Parse external script sources
  const $ = cheerio.load(html);
  const scriptSources = [];
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      scriptSources.push(absoluteUrl(src));
    }
  });

  // Fetch and check external scripts
  for (const src of scriptSources) {
    try {
      const res = await client.get(src, { timeout: 15000 });
      const config = parseLoadAgendaFromSource(res.data);
      if (config && (config.url || config.templateUrl)) {
        return config;
      }
    } catch (err) {
      console.warn(`Warning: unable to fetch script ${src}: ${err.message}`);
    }
  }

  return null;
}

/**
 * Parse agenda table from HTML
 * @param {string} html - Agenda HTML content
 * @param {Function} extractFileNumber - File number extraction function
 * @returns {Array} - Array of agenda items
 */
function parseAgendaTable(html, extractFileNumber) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const agendaItems = [];

  // Select tables structurally: two-column rows containing a loadAgendaItem link
  // with a numbered first cell (e.g. "1."). Avoids brittle CSS value matching.
  $('table').each((_, table) => {
    const $table = $(table);
    const $firstRow = $table.find('tbody > tr').first();
    const $cells = $firstRow.find('td');

    if ($cells.length < 2) return;

    const numberText = $cells.eq(0).text().trim();
    const numberMatch = numberText.match(/^(\d+)\./);
    if (!numberMatch) return;

    const contentCell = $cells.eq(1);

    const link = contentCell.find('a').filter((_, el) => {
      const href = $(el).attr('href') || '';
      return href.includes('loadAgendaItem');
    }).first();

    if (link.length === 0) return;

    const contentText = contentCell.text().trim();
    let agendaItemId = null;
    let hrefId = null;

    const href = link.attr('href') || '';
    const loadCall = href.match(/loadAgendaItem\((\d+)/);
    if (loadCall) {
      agendaItemId = loadCall[1];
    }
    hrefId = link.attr('id');

    agendaItems.push({
      number: parseInt(numberMatch[1], 10),
      agendaItemId,
      rawText: contentText,
      linkId: hrefId,
      extractedFileNumber: extractFileNumber(contentText)
    });
  });

  return agendaItems;
}

/**
 * Parse supporting documents from HTML
 * @param {string} html - HTML content
 * @returns {Array} - Array of document objects
 */
function parseSupportingDocuments(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const docs = [];
  
  $('a[href*="DownloadFile"]').each((_, link) => {
    const $link = $(link);
    const text = ($link.text() || '').trim();
    const title = ($link.attr('title') || '').trim();
    const href = absoluteUrl(convertToDirectPDFUrl($link.attr('href')));
    
    docs.push({
      text,
      title,
      url: href,
      originalHref: $link.attr('href')
    });
  });
  
  return docs;
}

/**
 * Format currency value
 * @param {number} value - Numeric value
 * @returns {string|null} - Formatted currency string
 */
function formatCurrency(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

module.exports = {
  BASE_URL,
  absoluteUrl,
  convertToDirectPDFUrl,
  extractMeetingDate,
  parseLoadAgendaFromSource,
  extractLoadAgendaConfig,
  parseAgendaTable,
  parseSupportingDocuments,
  formatCurrency
};

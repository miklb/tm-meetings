/**
 * HTTP Meeting Scraper Module
 * Reusable HTTP-based agenda scraping without Selenium
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const {
  BASE_URL,
  absoluteUrl,
  extractMeetingDate,
  extractLoadAgendaConfig,
  parseAgendaTable,
  parseSupportingDocuments,
  formatCurrency
} = require('./http-utils');

const {
  extractFolioNumbers,
  findTccPacketUrl,
  geocodeAddress
} = require('./pdf-folio-parser');

/**
 * Create an HTTP session with cookie jar
 * @returns {Object} - Axios client with cookie support
 */
async function createSession() {
  const { wrapper } = await import('axios-cookiejar-support');
  const jar = new CookieJar();
  
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    headers: {
      'User-Agent': 'agenda-scraper-http/2.3.0'
    }
  }));
}

/**
 * Fetch agenda document HTML
 * @param {Object} client - Axios client
 * @param {string} meetingId - Meeting ID
 * @returns {Promise<string>} - Agenda HTML
 */
async function fetchAgendaDocument(client, meetingId) {
  const agendaUrl = `${BASE_URL}/221agendaonline/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`;
  const response = await client.get(agendaUrl, { timeout: 30000 });
  return response.data;
}

/**
 * Fetch agenda item detail
 * @param {Object} client - Axios client
 * @param {string} itemId - Agenda item ID
 * @param {string} meetingId - Meeting ID
 * @param {Object} config - loadAgendaItem configuration
 * @returns {Promise<string>} - Item detail HTML
 */
async function fetchAgendaItemDetail(client, itemId, meetingId, config) {
  if (!config || (!config.url && !config.templateUrl)) {
    throw new Error('Missing loadAgendaItem configuration');
  }

  // Handle URL-based configuration
  if (config.url) {
    const url = absoluteUrl(config.url);
    const params = new URLSearchParams();
    params.set('itemId', itemId);
    params.set('meetingId', meetingId);
    params.set('doctype', '1');

    const headers = {
      'X-Requested-With': 'XMLHttpRequest'
    };

    if (config.method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }

    const requestConfig = {
      headers,
      timeout: 30000
    };

    let response;
    if (config.method === 'POST') {
      response = await client.post(url, params.toString(), requestConfig);
    } else {
      const query = new URLSearchParams(params);
      query.set('_', Date.now().toString());
      response = await client.get(`${url}?${query.toString()}`, requestConfig);
    }

    return response.data;
  }

  // Handle template URL configuration
  let urlFromTemplate = config.templateUrl;
  if (!urlFromTemplate) {
    throw new Error('loadAgendaItem template URL is unavailable');
  }

  urlFromTemplate = urlFromTemplate
    .replace(/meetingId=\d+/, `meetingId=${meetingId}`)
    .replace('ITEMIDVALUE', encodeURIComponent(itemId))
    .replace('ISSECTIONVALUE', 'false')
    .replace('AGENDATYPEVALUE', 'agenda');

  const response = await client.get(absoluteUrl(urlFromTemplate), {
    timeout: 30000,
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    }
  });

  return response.data;
}

/**
 * Extract summary sheet details (background, financial data)
 * @param {Object} client - Axios client
 * @param {Array} docs - Supporting documents
 * @param {Function} formatBackgroundText - Background formatter
 * @param {Function} parseSummaryFinancialEntries - Financial parser
 * @returns {Promise<Object>} - Summary sheet details
 */
async function extractSummarySheetDetails(client, docs, formatBackgroundText, parseSummaryFinancialEntries) {
  const result = {
    backgroundText: '',
    summaryText: '',
    financialEntries: [],
    summaryDoc: null
  };

  if (!docs || docs.length === 0) {
    return result;
  }

  const summaryDoc = docs.find(doc => {
    const haystack = `${doc.text} ${doc.title}`.toLowerCase();
    return haystack.includes('summary sheet') && haystack.includes('cover sheet');
  });

  if (!summaryDoc || !summaryDoc.url) {
    return result;
  }

  try {
    const response = await client.get(summaryDoc.url, { responseType: 'arraybuffer', timeout: 90000 });
    
    // Suppress pdf-parse warnings by temporarily redirecting stderr
    const originalStderrWrite = process.stderr.write;
    process.stderr.write = () => {};
    
    const pdfData = await pdfParse(response.data);
    
    // Restore stderr
    process.stderr.write = originalStderrWrite;
    
    const text = pdfData.text || '';

    result.summaryText = text;
    result.summaryDoc = summaryDoc;
    result.financialEntries = parseSummaryFinancialEntries(text);

    // Extract background section
    const backgroundPatterns = [
      /background\s*:?([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|$))/i,
      /background\s*information\s*:?([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|$))/i,
      /project\s*background\s*:?([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|$))/i
    ];

    for (const pattern of backgroundPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const cleaned = formatBackgroundText(match[1].trim());
        if (cleaned.length > 20) {
          result.backgroundText = cleaned;
          break;
        }
      }
    }
  } catch (err) {
    console.warn(`Warning: summary sheet extraction failed: ${err.message}`);
  }

  return result;
}

/**
 * Extract agenda type (DRAFT or FINAL) from HTML
 * The header contains spaced-out text like "R E G U L A R   F I N A L   A G E N D A"
 * @param {string} html - HTML content
 * @returns {string} - "DRAFT" or "FINAL"
 */
function extractAgendaType(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  let agendaType = 'DRAFT'; // Default to DRAFT
  
  $('h1').each((i, el) => {
    const text = $(el).text().trim();
    // Remove all spaces to normalize the spaced-out text
    const normalizedText = text.replace(/\s+/g, '').toUpperCase();
    // Check for FINAL or DRAFT in the normalized text
    if (normalizedText.includes('FINAL')) {
      agendaType = 'FINAL';
      return false; // break out of each loop
    } else if (normalizedText.includes('DRAFT')) {
      agendaType = 'DRAFT';
      return false;
    }
  });
  
  return agendaType;
}

/**
 * Detect if agenda is an addendum to another agenda
 * Addendums contain "ADDENDUM" in the page content
 * @param {string} html - HTML content
 * @returns {boolean} - true if this is an addendum
 */
function isAddendumAgenda(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  // Check all text content for "ADDENDUM"
  const bodyText = $('body').text().replace(/\s+/g, ' ').toUpperCase();
  
  // Look for specific addendum patterns
  return bodyText.includes('ADDENDUM TO FINAL AGENDA') || 
         bodyText.includes('ADDENDUM TO DRAFT AGENDA') ||
         bodyText.includes('ADDENDUMTOFINALAGENDA') ||
         bodyText.includes('ADDENDUMTODRAFTAGENDA');
}

/**
 * Fetch complete meeting data via HTTP
 * @param {string} meetingId - Meeting ID
 * @param {string} meetingType - Meeting type (regular, evening, special, workshop)
 * @param {Object} options - Additional options
 * @param {Object} options.session - Existing axios session (optional)
 * @param {boolean} options.saveDebugFiles - Save HTML files to output/ (default: true)
 * @param {Function} options.extractFileNumber - File number extraction function (required)
 * @param {Function} options.extractDollarAmounts - Dollar amount extraction function (required)
 * @param {Function} options.formatBackgroundText - Background formatter (required)
 * @param {Function} options.parseSummaryFinancialEntries - Financial parser (required)
 * @returns {Promise<Object>} - Meeting data object
 */
async function fetchMeeting(meetingId, meetingType = 'regular', options = {}) {
  const {
    session,
    saveDebugFiles = true,
    extractFileNumber,
    extractDollarAmounts,
    formatBackgroundText,
    parseSummaryFinancialEntries
  } = options;

  // Validate required dependencies
  if (!extractFileNumber || !extractDollarAmounts || !formatBackgroundText || !parseSummaryFinancialEntries) {
    throw new Error('Missing required extraction functions in options');
  }

  const client = session || await createSession();
  const meetingUrl = `${BASE_URL}/221agendaonline/Meetings/ViewMeeting?id=${meetingId}&doctype=1`;

  console.log(`[HTTP] Fetching meeting ${meetingId}...`);
  
  // Fetch meeting page
  const meetingResponse = await client.get(meetingUrl, { timeout: 30000 });
  const html = meetingResponse.data;

  if (saveDebugFiles) {
    const debugMeetingPath = path.join(process.cwd(), 'output', `http_meeting_${meetingId}.html`);
    fs.writeFileSync(debugMeetingPath, html);
    console.log(`[HTTP] Saved meeting HTML: output/http_meeting_${meetingId}.html`);
  }

  // Extract loadAgendaItem configuration
  const loadConfig = await extractLoadAgendaConfig(client, html);
  if (!loadConfig || (!loadConfig.url && !loadConfig.templateUrl)) {
    throw new Error('Unable to locate loadAgendaItem configuration');
  }

  console.log(`[HTTP] Found loadAgendaItem endpoint: ${loadConfig.url || loadConfig.templateUrl}`);

  // Fetch agenda document
  const agendaHtml = await fetchAgendaDocument(client, meetingId);
  
  if (saveDebugFiles) {
    const agendaPath = path.join(process.cwd(), 'output', `http_agenda_${meetingId}.html`);
    fs.writeFileSync(agendaPath, agendaHtml);
    console.log(`[HTTP] Saved agenda HTML: output/http_agenda_${meetingId}.html`);
  }

  // Parse agenda table
  const agendaItems = parseAgendaTable(agendaHtml, extractFileNumber);
  console.log(`[HTTP] Found ${agendaItems.length} agenda items`);

  if (agendaItems.length === 0) {
    console.warn('[HTTP] No agenda items found');
    return {
      meetingId,
      meetingType,
      agendaType: extractAgendaType(agendaHtml),
      meetingDate: extractMeetingDate(html) || extractMeetingDate(agendaHtml) || '',
      agendaItems: []
    };
  }

  // Extract meeting date
  let meetingDate = extractMeetingDate(html);
  if (!meetingDate) {
    meetingDate = extractMeetingDate(agendaHtml);
  }
  console.log(`[HTTP] Meeting date: ${meetingDate || '[unknown]'}`);

  // Extract agenda type (DRAFT or FINAL)
  const agendaType = extractAgendaType(agendaHtml);
  console.log(`[HTTP] Agenda type: ${agendaType}`);

  // Process each agenda item with concurrency limit
  const processedItems = [];
  const cheerio = require('cheerio');
  const CONCURRENCY = 5; // Process 5 items in parallel
  
  // Helper function to process a single item
  async function processItem(item, idx) {
    if (!item.agendaItemId) {
      // No detail page available
      const basicDollarInfo = extractDollarAmounts(item.rawText);
      return {
        number: item.number,
        agendaItemId: null,
        title: item.rawText,
        rawTitle: item.rawText, // Raw text for WordPress cleaning
        fileNumber: item.extractedFileNumber,
        background: '',
        supportingDocuments: [],
        folioNumbers: [], // Empty for items without details
        location: '', // Empty for items without details
        coordinates: null, // No coordinates for items without details
        dollarAmounts: basicDollarInfo.amounts,
        financialDetails: basicDollarInfo.details,
        financialTotals: basicDollarInfo.totals
      };
    }

    const progress = `${idx + 1}/${agendaItems.length}`;
    console.log(`[HTTP] Fetching item ${item.number} (${progress})...`);
    
    let detailHtml;
    try {
      detailHtml = await fetchAgendaItemDetail(client, item.agendaItemId, meetingId, loadConfig);
    } catch (err) {
      console.warn(`[HTTP] Failed to fetch item ${item.number}: ${err.message}`);
      const fallbackDollarInfo = extractDollarAmounts(item.rawText);
      return {
        number: item.number,
        agendaItemId: item.agendaItemId,
        title: item.rawText,
        rawTitle: item.rawText, // Raw text for WordPress cleaning
        fileNumber: item.extractedFileNumber,
        background: '',
        supportingDocuments: [],
        folioNumbers: [], // Empty for failed items
        location: '', // Empty for failed items
        coordinates: null, // No coordinates for failed items
        dollarAmounts: fallbackDollarInfo.amounts,
        financialDetails: fallbackDollarInfo.details,
        financialTotals: fallbackDollarInfo.totals,
        error: err.message
      };
    }

    const $ = cheerio.load(detailHtml);
    const title = $('.item-view-title-text').text().trim() || item.rawText;
    
    // Parse supporting documents
    const supportingDocuments = parseSupportingDocuments(detailHtml).map(doc => ({
      title: doc.text || doc.title || 'Document',
      url: doc.url,
      originalTitle: doc.title,
      originalText: doc.text
    }));

    // Extract summary sheet details
    const summaryDetails = await extractSummarySheetDetails(
      client,
      supportingDocuments,
      formatBackgroundText,
      parseSummaryFinancialEntries
    );

    // Get background text (prefer summary sheet)
    let backgroundText = summaryDetails.backgroundText;
    if (!backgroundText) {
      const backgroundBlock = $('div:contains("Background")').nextUntil('div:contains("Fiscal")').text().trim();
      if (backgroundBlock) {
        backgroundText = formatBackgroundText(backgroundBlock);
      }
    }

    // Extract financial information
    const detailPlainText = $('#itemView').text().trim();
    const dollarInfo = extractDollarAmounts(title, {
      additionalTexts: [item.rawText, detailPlainText, summaryDetails.summaryText].filter(Boolean),
      summaryEntries: summaryDetails.financialEntries
    });

    // Extract folio numbers and location from TA/CPA TCC PACKET PDFs
    let folioData = { folioNumbers: [], address: '', coordinates: null };
    const fileNum = extractFileNumber(title) || item.extractedFileNumber;
    
    if (fileNum && /^TA[\/\s]?CPA/i.test(fileNum)) {
      const tccPacketUrl = findTccPacketUrl(supportingDocuments);
      if (tccPacketUrl) {
        try {
          console.log(`[HTTP] Extracting location & folios for ${fileNum}...`);
          folioData = await extractFolioNumbers(tccPacketUrl, fileNum);
        } catch (error) {
          console.error(`[HTTP] Folio extraction failed for ${fileNum}:`, error.message);
        }
      } else {
        // No TCC PACKET - try extracting folio numbers from title text
        // Pattern: "Folio Number(s) 123456-0000, 789012-0000 and 345678-0000"
        // Extract the section after "Folio Number(s)" up to the next major clause
        const folioSectionMatch = title.match(/Folio\s+Numbers?\s+([^,.]+(?:[,\s]+(?:and\s+)?[\d\-]+)*)/i);
        if (folioSectionMatch) {
          const folioText = folioSectionMatch[1];
          // Extract all folio patterns like 123456-0000 or 123456.0000
          const folioPattern = /\b(\d{5,8}[.\-]\d{4})\b/g;
          const matches = folioText.match(folioPattern);
          if (matches) {
            folioData.folioNumbers = matches.map(f => f.replace(/\./g, '-'));
            console.log(`[HTTP] Extracted ${folioData.folioNumbers.length} folio numbers from title for ${fileNum}`);
          }
        }
      }
    }
    
    // Extract address and geocode for SU1 and VAC items (from title text)
    // These item types have addresses in the title but aren't in the ArcGIS GeoJSON endpoint
    if (fileNum && /^(SU1|VAC)/i.test(fileNum) && !folioData.coordinates) {
      // Extract address from "property located at ADDRESS" or "generally located at ADDRESS" patterns
      // Handle street abbreviations with periods (Dr., St., Ave., Blvd., Jr., etc.)
      const addressMatch = title.match(/(?:property|generally)\s+located\s+at\s+([\d]+[^(]+?)(?:\s*\(|$)/i);
      if (addressMatch) {
        // Clean up: trim whitespace and trailing period
        const extractedAddress = addressMatch[1].trim().replace(/\.$/, '');
        console.log(`[HTTP] Extracting location for ${fileNum}: "${extractedAddress}"`);
        try {
          const coords = await geocodeAddress(extractedAddress);
          if (coords) {
            folioData.address = extractedAddress;
            folioData.coordinates = coords;
          }
        } catch (error) {
          console.error(`[HTTP] Geocoding failed for ${fileNum}:`, error.message);
        }
      }
    }

    return {
      number: item.number,
      agendaItemId: item.agendaItemId,
      title,
      rawTitle: title, // Raw text for WordPress cleaning
      fileNumber: fileNum,
      background: backgroundText,
      supportingDocuments,
      folioNumbers: folioData.folioNumbers || [], // Array of folio numbers
      location: folioData.address || '', // First address from Location section
      coordinates: folioData.coordinates || null, // {lat, lng} or null
      dollarAmounts: dollarInfo.amounts,
      financialDetails: dollarInfo.details,
      financialTotals: dollarInfo.totals
    };
  }
  
  // Process items in batches with concurrency limit
  for (let i = 0; i < agendaItems.length; i += CONCURRENCY) {
    const batch = agendaItems.slice(i, i + CONCURRENCY);
    const batchPromises = batch.map((item, batchIdx) => processItem(item, i + batchIdx));
    const batchResults = await Promise.all(batchPromises);
    processedItems.push(...batchResults);
  }

  // Detect if this is an addendum agenda
  const isAddendum = isAddendumAgenda(agendaHtml);
  if (isAddendum) {
    console.log(`[HTTP] Detected ADDENDUM agenda for meeting ${meetingId}`);
  }

  // Build meeting data object
  const meetingData = {
    meetingId,
    meetingType,
    agendaType,
    isAddendum,
    meetingDate,
    sourceUrl: `${BASE_URL}/221agendaonline/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`,
    agendaItems: processedItems
  };

  // Calculate financial summary if items have financial data
  const hasFinancialDetails = processedItems.some(
    item => Array.isArray(item.financialDetails) && item.financialDetails.length > 0
  );

  if (hasFinancialDetails) {
    const aggregate = { expenditures: 0, decreases: 0, revenues: 0, other: 0, net: 0 };

    processedItems.forEach(item => {
      const totals = item.financialTotals || { expenditures: 0, decreases: 0, revenues: 0, other: 0, net: 0 };
      aggregate.expenditures += totals.expenditures || 0;
      aggregate.decreases += totals.decreases || 0;
      aggregate.revenues += totals.revenues || 0;
      aggregate.other += totals.other || 0;
      aggregate.net += totals.net || 0;
    });

    // Find smallest and largest expenditure items
    const itemsWithExpenditures = processedItems
      .filter(item => item.financialTotals && item.financialTotals.expenditures > 0)
      .map(item => ({
        number: item.number,
        agendaItemId: item.agendaItemId,
        fileNumber: item.fileNumber,
        title: item.title,
        expenditure: item.financialTotals.expenditures
      }))
      .sort((a, b) => a.expenditure - b.expenditure);

    let expenditureRange = null;
    if (itemsWithExpenditures.length > 0) {
      const smallest = itemsWithExpenditures[0];
      const largest = itemsWithExpenditures[itemsWithExpenditures.length - 1];
      expenditureRange = {
        smallest: {
          number: smallest.number,
          agendaItemId: smallest.agendaItemId,
          fileNumber: smallest.fileNumber,
          title: smallest.title,
          amount: smallest.expenditure,
          formatted: formatCurrency(smallest.expenditure)
        },
        largest: {
          number: largest.number,
          agendaItemId: largest.agendaItemId,
          fileNumber: largest.fileNumber,
          title: largest.title,
          amount: largest.expenditure,
          formatted: formatCurrency(largest.expenditure)
        },
        count: itemsWithExpenditures.length
      };
    }

    meetingData.financialSummary = {
      ...aggregate,
      formatted: {
        expenditures: formatCurrency(aggregate.expenditures),
        decreases: formatCurrency(-aggregate.decreases),
        revenues: formatCurrency(-aggregate.revenues),
        other: formatCurrency(aggregate.other),
        net: formatCurrency(aggregate.net)
      },
      expenditureRange
    };
  }

  console.log(`[HTTP] Meeting ${meetingId} complete: ${processedItems.length} items processed`);
  
  return meetingData;
}

/**
 * Fetch meeting list from main agenda page
 * @param {Object} options - Options
 * @param {Object} options.session - Existing axios session (optional)
 * @returns {Promise<Array>} - Array of meeting objects with id, type, href
 */
async function fetchMeetingList(options = {}) {
  const { session } = options;
  const client = session || await createSession();
  const url = `${BASE_URL}/221agendaonline/`;

  console.log('[HTTP] Fetching meeting list...');
  
  const response = await client.get(url, { timeout: 30000 });
  const html = response.data;
  
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const meetings = [];

  $('#meetings-list-upcoming table:first-of-type tr').each((i, tr) => {
    const $tr = $(tr);
    const meetingId = $tr.attr('data-meeting-id');
    
    if (!meetingId) return;

    const lastTd = $tr.find('td').last();
    const links = lastTd.find('a[href]');
    
    // Check if row has an agenda link (not just summary)
    let hasAgendaLink = false;
    links.each((j, link) => {
      const linkText = $(link).text().trim().toLowerCase();
      const linkHref = $(link).attr('href') || '';
      
      if ((linkText.includes('agenda') && !linkText.includes('summary')) ||
          (linkHref.includes('doctype=1') && !linkText.includes('summary'))) {
        hasAgendaLink = true;
      }
    });

    if (!hasAgendaLink) return;

    // Determine meeting type from row content
    const rowText = $tr.text().toLowerCase();
    let meetingType = 'regular';
    
    if (rowText.includes('evening')) {
      meetingType = 'evening';
    } else if (rowText.includes('workshop')) {
      meetingType = 'workshop';
    } else if (rowText.includes('special')) {
      meetingType = 'special';
    } else if (rowText.includes('cra') || rowText.includes('community redevelopment')) {
      meetingType = 'cra';
    }

    const agendaLink = links.filter((_, link) => {
      const href = $(link).attr('href') || '';
      return href.includes('ViewMeeting') && href.includes('doctype=1');
    }).first();

    meetings.push({
      id: meetingId,
      type: meetingType,
      href: agendaLink.length > 0 ? absoluteUrl(agendaLink.attr('href')) : null
    });
  });

  console.log(`[HTTP] Found ${meetings.length} meetings`);
  
  return meetings;
}

module.exports = {
  createSession,
  fetchMeeting,
  fetchMeetingList,
  fetchAgendaDocument,
  fetchAgendaItemDetail,
  extractSummarySheetDetails
};

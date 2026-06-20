/**
 * HTTP Meeting Scraper Module
 * Reusable HTTP-based agenda scraping without Selenium
 */

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const fs = require('fs');
const path = require('path');
const { extractTextFromBuffer } = require('./pdf-text-extractor');
const { extractBackgroundSection } = require('./summary-sheet-parser');
const { parseFiscalSections } = require('./projected-costs-parser');

const {
  BASE_URL,
  AGENDA_BASE,
  absoluteUrl,
  extractMeetingDate,
  extractLoadAgendaConfig,
  parseAgendaTable,
  parseAddendumSections,
  parseStaticAddendumItems,
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
  const agendaUrl = `${AGENDA_BASE}/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`;
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
    projectedCosts: null,
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

    const { text } = await extractTextFromBuffer(Buffer.from(response.data));

    result.summaryText = text;
    result.summaryDoc = summaryDoc;
    result.financialEntries = parseSummaryFinancialEntries(text);

    // New authoritative parser: extract structured rows from the
    // PROJECTED COSTS: section and the FISCAL IMPACT STATEMENT paragraph.
    // This is the only fiscal data downstream consumers should rely on.
    result.projectedCosts = parseFiscalSections(text);

    // Extract background section using the shared, header-aware extractor.
    // (Earlier versions used a single regex with case-insensitive lookaheads
    // that misfired on body text containing words like "recommendation",
    // truncating Background mid-paragraph.)
    const rawBackground = extractBackgroundSection(text);
    if (rawBackground) {
      const cleaned = formatBackgroundText(rawBackground);
      if (cleaned && cleaned.length > 20) {
        result.backgroundText = cleaned;
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
  const meetingUrl = `${AGENDA_BASE}/Meetings/ViewMeeting?id=${meetingId}&doctype=1`;

  console.log(`[HTTP] Fetching meeting ${meetingId}...`);
  
  // Fetch meeting page
  const meetingResponse = await client.get(meetingUrl, { timeout: 30000 });
  const html = meetingResponse.data;

  // Detect server-side "Meeting not available" response early
  if (html.includes('Meeting not available')) {
    console.warn(`[HTTP] Meeting ${meetingId} is not available on the server — skipping.`);
    return null;
  }

  if (saveDebugFiles) {
    const outputDir = path.join(process.cwd(), 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const debugMeetingPath = path.join(outputDir, `http_meeting_${meetingId}.html`);
    fs.writeFileSync(debugMeetingPath, html);
    console.log(`[HTTP] Saved meeting HTML: output/http_meeting_${meetingId}.html`);
  }

  // Extract loadAgendaItem configuration
  const loadConfig = await extractLoadAgendaConfig(client, html);
  if (!loadConfig || (!loadConfig.url && !loadConfig.templateUrl)) {
    console.warn(`[HTTP] Warning: Unable to locate loadAgendaItem configuration for meeting ${meetingId}. Item details will be unavailable.`);
  } else {
    console.log(`[HTTP] Found loadAgendaItem endpoint: ${loadConfig.url || loadConfig.templateUrl}`);
  }

  // Fetch agenda document
  const agendaHtml = await fetchAgendaDocument(client, meetingId);
  
  if (saveDebugFiles) {
    const outputDir = path.join(process.cwd(), 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const agendaPath = path.join(outputDir, `http_agenda_${meetingId}.html`);
    fs.writeFileSync(agendaPath, agendaHtml);
    console.log(`[HTTP] Saved agenda HTML: output/http_agenda_${meetingId}.html`);
  }

  // Parse agenda table
  let agendaItems = parseAgendaTable(agendaHtml, extractFileNumber);
  console.log(`[HTTP] Found ${agendaItems.length} agenda items`);

  // Detect if this is an addendum agenda
  const isAddendum = isAddendumAgenda(agendaHtml);

  // Some addenda (e.g. CRA) are static Word-converted documents with no
  // loadAgendaItem links, so the structural parse finds nothing. Fall back
  // to the static addendum parser before giving up.
  if (agendaItems.length === 0 && isAddendum) {
    agendaItems = parseStaticAddendumItems(agendaHtml, extractFileNumber);
    console.log(`[HTTP] Static addendum fallback found ${agendaItems.length} item(s)`);
  }

  if (agendaItems.length === 0) {
    console.warn('[HTTP] No agenda items found');
    return {
      meetingId,
      meetingType,
      agendaType: extractAgendaType(agendaHtml),
      isAddendum,
      meetingDate: extractMeetingDate(html) || extractMeetingDate(agendaHtml) || '',
      sourceUrl: `${AGENDA_BASE}/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`,
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
      financialTotals: dollarInfo.totals,
      // Authoritative fiscal data extracted from the Summary Sheet's
      // PROJECTED COSTS: section. Replaces the heuristic financialDetails
      // for downstream funding manifests and rendering.
      summaryText: summaryDetails.summaryText || '',
      projectedCosts: summaryDetails.projectedCosts || null
    };
  }
  
  // Process items in batches with concurrency limit
  for (let i = 0; i < agendaItems.length; i += CONCURRENCY) {
    const batch = agendaItems.slice(i, i + CONCURRENCY);
    const batchPromises = batch.map((item, batchIdx) => processItem(item, i + batchIdx));
    const batchResults = await Promise.all(batchPromises);
    processedItems.push(...batchResults);
  }

  if (isAddendum) {
    console.log(`[HTTP] Detected ADDENDUM agenda for meeting ${meetingId}`);

    // Parse section headers and attach metadata to each item
    const sectionMap = parseAddendumSections(agendaHtml);
    const CONTINUANCE_RE = /continuance.*?\bto\s+([A-Z][a-z]+\s+\d{1,2},?\s*\d{4})/i;

    processedItems.forEach((item, idx) => {
      // Static-addendum fallback items carry their section directly (and may
      // have no number for sectionMap to key on, e.g. walk-ons).
      item.addendumSection = sectionMap.get(item.number) ?? agendaItems[idx].addendumSection ?? null;
      const match = (item.title || '').match(CONTINUANCE_RE);
      item.continuedToDate = match ? match[1].replace(/,\s*/, ', ').trim() : null;
    });
  }

  // Build meeting data object
  const meetingData = {
    meetingId,
    meetingType,
    agendaType,
    isAddendum,
    meetingDate,
    sourceUrl: `${AGENDA_BASE}/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`,
    agendaItems: processedItems
  };

  // Build simplified financial summary: total money discussed + range
  const itemsWithDollarAmounts = processedItems.filter(item =>
    Array.isArray(item.dollarAmounts) && item.dollarAmounts.length > 0
  );

  if (itemsWithDollarAmounts.length > 0) {
    // Skip Part 2 items to avoid double-counting (Part 1 has the contract, Part 2 is the appropriation)
    const part2Pattern = /\bPart\s+2\b.*\bSee\s+Item\s+\d+\b/i;

    // For each item, use its largest dollar amount as the representative figure
    const itemFinancials = itemsWithDollarAmounts
      .filter(item => !part2Pattern.test(item.title || ''))
      .map(item => {
        const values = item.dollarAmounts.map(
          a => parseFloat(a.replace(/[$,]/g, '')) || 0
        );
        const maxAmount = Math.max(...values);
        return {
          number: item.number,
          fileNumber: item.fileNumber,
          amount: maxAmount
        };
      })
      .filter(item => item.amount > 0)
      .sort((a, b) => a.amount - b.amount);

    const totalAmountDiscussed = itemFinancials.reduce((sum, item) => sum + item.amount, 0);

    let range = null;
    if (itemFinancials.length > 0) {
      const smallest = itemFinancials[0];
      const largest = itemFinancials[itemFinancials.length - 1];
      range = {
        smallest: {
          number: smallest.number,
          fileNumber: smallest.fileNumber,
          amount: smallest.amount,
          formatted: formatCurrency(smallest.amount)
        },
        largest: {
          number: largest.number,
          fileNumber: largest.fileNumber,
          amount: largest.amount,
          formatted: formatCurrency(largest.amount)
        }
      };
    }

    // Expenditure-specific totals with section-aware deduplication.
    // Summary sheets have a fiscal_impact total and projected_costs broken out by year.
    // Projected costs are a breakdown of the fiscal impact — not additional money.
    const expenditureItems = itemsWithDollarAmounts
      .filter(item => !part2Pattern.test(item.title || ''))
      .map(item => {
        const expDetails = (item.financialDetails || []).filter(d => d.type === 'expenditure');
        if (expDetails.length === 0) return null;

        const fiscalImpact = expDetails.filter(d => d.section === 'fiscal_impact');
        const projectedCosts = expDetails.filter(d => d.section === 'projected_costs');

        let amount;
        if (fiscalImpact.length > 0) {
          // Fiscal impact has the authoritative total
          amount = Math.max(...fiscalImpact.map(d => d.value));
        } else if (projectedCosts.length > 0) {
          // No fiscal impact total — sum projected costs across fiscal years
          amount = projectedCosts.reduce((sum, d) => sum + d.value, 0);
        } else {
          // No section info — use max expenditure amount
          amount = Math.max(...expDetails.map(d => d.value));
        }

        return {
          number: item.number,
          fileNumber: item.fileNumber,
          amount
        };
      })
      .filter(item => item && item.amount > 0)
      .sort((a, b) => a.amount - b.amount);

    const totalExpenditures = expenditureItems.reduce((sum, item) => sum + item.amount, 0);

    let expenditureRange = null;
    if (expenditureItems.length > 0) {
      const smallest = expenditureItems[0];
      const largest = expenditureItems[expenditureItems.length - 1];
      expenditureRange = {
        smallest: {
          number: smallest.number,
          fileNumber: smallest.fileNumber,
          amount: smallest.amount,
          formatted: formatCurrency(smallest.amount)
        },
        largest: {
          number: largest.number,
          fileNumber: largest.fileNumber,
          amount: largest.amount,
          formatted: formatCurrency(largest.amount)
        },
        count: expenditureItems.length
      };
    }

    meetingData.financialSummary = {
      totalAmountDiscussed,
      formattedTotalAmountDiscussed: formatCurrency(totalAmountDiscussed),
      itemCount: itemFinancials.length,
      range,
      totalExpenditures,
      formattedTotalExpenditures: formatCurrency(totalExpenditures),
      expenditureRange,
      expenditureItems: expenditureItems.map(item => ({
        number: item.number,
        fileNumber: item.fileNumber,
        amount: item.amount,
        formatted: formatCurrency(item.amount)
      }))
    };
  }

  console.log(`[HTTP] Meeting ${meetingId} complete: ${processedItems.length} items processed`);
  
  return meetingData;
}

/**
 * Fetch meeting list from main agenda page
 * v251 embeds meeting data as JSON in an inline script call to showSearchResults()
 * @param {Object} options - Options
 * @param {Object} options.session - Existing axios session (optional)
 * @returns {Promise<Array>} - Array of meeting objects with id, type, href
 */
async function fetchMeetingList(options = {}) {
  const { session } = options;
  const client = session || await createSession();
  const url = `${AGENDA_BASE}/`;

  console.log('[HTTP] Fetching meeting list...');
  
  const response = await client.get(url, { timeout: 30000 });
  const html = response.data;
  
  // v251: meetings are embedded as JSON in showSearchResults(new SearchResults({...}))
  const jsonMatch = html.match(/showSearchResults\(new\s+SearchResults\((\{[\s\S]*?\})\)\)/);
  if (!jsonMatch) {
    console.log('[HTTP] Warning: Could not find embedded meeting JSON, falling back to HTML parsing');
    return fetchMeetingListFromHTML(html);
  }

  let data;
  try {
    data = JSON.parse(jsonMatch[1]);
  } catch (e) {
    console.log(`[HTTP] Warning: Failed to parse embedded JSON: ${e.message}`);
    return fetchMeetingListFromHTML(html);
  }

  const meetings = [];
  for (const m of (data.Meetings || [])) {
    // Only include meetings that have an agenda available
    if (!m.IsAgendaAvailable) continue;

    const name = (m.Name || '').toLowerCase();
    const typeName = (m.MeetingTypeName || '').toLowerCase();

    // Skip non-council meetings. Use an allowlist keyed on MeetingTypeName so that
    // names like "Special Magistrate" don't slip through on the word "special".
    const ALLOWED_TYPES = new Set([
      'council regular', 'council evening', 'council workshop',
      'council special', 'council calendar',
      'cra regular', 'cra special',
    ]);
    if (!ALLOWED_TYPES.has(typeName)) continue;

    let meetingType = 'regular';

    if (typeName.includes('evening')) {
      meetingType = 'evening';
    } else if (typeName.includes('workshop') || typeName.includes('calendar')) {
      meetingType = 'workshop';
    } else if (typeName.includes('special')) {
      meetingType = 'special';
    } else if (typeName.includes('cra')) {
      meetingType = 'cra';
    }

    // Normalise the OnBase date (tries common field names) to YYYY-MM-DD
    let date = null;
    const rawDate = m.MeetingStartDate || m.MeetingDate || m.StartDateTime || m.Date || null;
    if (rawDate) {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        date = d.toISOString().slice(0, 10);
      }
    }

    meetings.push({
      id: String(m.ID),
      type: meetingType,
      href: `${AGENDA_BASE}/Meetings/ViewMeeting?id=${m.ID}&doctype=1`,
      date
    });
  }

  console.log(`[HTTP] Found ${meetings.length} meetings`);
  return meetings;
}

/**
 * Fallback: parse meeting list from HTML tables (v221 format)
 * @param {string} html - Page HTML
 * @returns {Array} - Array of meeting objects
 */
function fetchMeetingListFromHTML(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const meetings = [];

  $('#meetings-list-upcoming table:first-of-type tr').each((i, tr) => {
    const $tr = $(tr);
    const meetingId = $tr.attr('data-meeting-id');
    
    if (!meetingId) return;

    const lastTd = $tr.find('td').last();
    const links = lastTd.find('a[href]');
    
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

    const rowText = $tr.text().toLowerCase();

    // Skip non-council meetings. "special magistrate" contains "special" so
    // check the blocklist before the meetingType branch below.
    if (rowText.includes('code enforcement') || rowText.includes('special magistrate')) return;

    let meetingType = 'regular';

    if (rowText.includes('evening')) {
      meetingType = 'evening';
    } else if (rowText.includes('workshop') || rowText.includes('calendar')) {
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

    // Try to extract a date (MM/DD/YYYY) from the row text
    let date = null;
    const rowRawText = $tr.text();
    const dateMatch = rowRawText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dateMatch) {
      const [, month, day, year] = dateMatch;
      date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    meetings.push({
      id: meetingId,
      type: meetingType,
      href: agendaLink.length > 0 ? absoluteUrl(agendaLink.attr('href')) : null,
      date
    });
  });

  console.log(`[HTTP] Found ${meetings.length} meetings (HTML fallback)`);
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

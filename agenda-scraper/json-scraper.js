const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { toTitleCase } = require('./format-helpers');
const { integrateStaffReportsIntoAgendaItems } = require('./staff-report-parser');

// HTTP scraper module (default)
const { createSession, fetchMeeting, fetchMeetingList } = require('./lib/http-meeting-scraper');

/**
 * Format a date string for use in filenames (converts to YYYY-MM-DD format)
 * @param {string} dateStr - Date string in various formats
 * @returns {string} - Formatted date string or empty string if invalid
 */
function formatDateForFilename(dateStr) {
    if (!dateStr) return '';
    
    try {
        // Handle common date formats
        let date;
        
        // Try parsing MM/DD/YYYY format
        const mmddyyyy = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (mmddyyyy) {
            const [, month, day, year] = mmddyyyy;
            date = new Date(year, month - 1, day);
        }
        // Try parsing YYYY-MM-DD format
        else if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            date = new Date(dateStr);
        }
        // Try parsing "Month DD, YYYY" format
        else {
            date = new Date(dateStr);
        }
        
        // Validate the date
        if (isNaN(date.getTime())) {
            return '';
        }
        
        // Format as YYYY-MM-DD
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    } catch (error) {
        return '';
    }
}

/**
 * Format background text to properly structure numbered lists and improve readability
 * @param {string} text - Raw background text from PDF
 * @returns {string} - Formatted background text
 */
function formatBackgroundText(text) {
    if (!text || text.trim().length === 0) return text;
    
    // Structure-based PDF formatting - trust the PDF parser's output
    // Only clean up obvious PDF artifacts that don't affect structure
    let cleanText = text
        // Fix split dollar amounts like "$452,\n962.55" -> "$452,962.55"  
        .replace(/\$(\d{1,3}(?:,\d{3})*),\s*\n\s*(\d{3}(?:\.\d{2})?)/g, '$$$1,$2')
        // Fix split document references like "R\n1182" -> "R1182"
        .replace(/\b(Resolution|Contract|Case|File|R)\s*\n\s*(\d+)/gi, '$1$2')
        // Fix split contract numbers, case numbers, etc.
        .replace(/(\b(?:Contract|Resolution|Case|File|No\.?|Number))\s*\n\s*([A-Z0-9-]+)/gi, '$1 $2')
        // Fix split dates like "01/05/\n2024" -> "01/05/2024"
        .replace(/(\d{1,2}\/\d{1,2}\/)\s*\n\s*(\d{4})/g, '$1$2')
        .trim();
    
    // Use the PDF's natural structure: split on lines and analyze the structure
    const lines = cleanText.split('\n');
    const processedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Check if this line starts a numbered item
        if (/^\d+\.\s+/.test(line)) {
            // This is a numbered item - add with separation
            if (processedLines.length > 0) {
                processedLines.push(''); // Add separation before new numbered item
            }
            processedLines.push(line);
        } else {
            // This is a continuation line
            // Check if the previous line ended with a sentence-ending punctuation
            const lastLine = processedLines[processedLines.length - 1];
            
            if (lastLine && (lastLine.endsWith('.') || lastLine.endsWith('!') || lastLine.endsWith('?'))) {
                // Previous line ended with sentence-ending punctuation
                // This suggests a natural paragraph break in the PDF
                processedLines.push(''); // Add separation
                processedLines.push(line);
            } else {
                // This is a continuation of the previous line
                if (processedLines.length > 0) {
                    processedLines[processedLines.length - 1] += ' ' + line;
                } else {
                    processedLines.push(line);
                }
            }
        }
    }
    
    // Join with double newlines and clean up
    const result = processedLines
        .filter(line => line !== undefined && line !== null)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
        
    return result;
}

/**
 * Convert relative URL to direct PDF URL for downloading
 * @param {string} downloadFileUrl - Original download file URL
 * @returns {string} - Direct PDF URL
 */
function convertToDirectPDFUrl(downloadFileUrl) {
    // Convert DownloadFile to DownloadFileBytes for direct PDF access
    if (downloadFileUrl.includes('DownloadFile') && !downloadFileUrl.includes('DownloadFileBytes')) {
        return downloadFileUrl.replace('DownloadFile', 'DownloadFileBytes');
    }
    return downloadFileUrl;
}

/**
 * Extract background text from a PDF using the browser session with retry logic
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} pdfRelativeUrl - Relative URL to the PDF
 * @returns {Promise<string>} - Extracted background text
 */
async function extractBackgroundFromPDFWithBrowser(driver, pdfRelativeUrl) {
    const maxRetries = 2;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await extractBackgroundFromPDFAttempt(driver, pdfRelativeUrl);
        } catch (error) {
            lastError = error;
            if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
                console.log(`PDF extraction attempt ${attempt}/${maxRetries} failed due to timeout (server may be slow): ${error.message}`);
            } else {
                console.log(`PDF extraction attempt ${attempt}/${maxRetries} failed: ${error.message}`);
            }
            
            if (attempt < maxRetries) {
                const delay = attempt * 3000; // Increased to 3s, then 6s delay for slow server days
                console.log(`Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    // If all retries failed, throw the last error
    throw lastError;
}

/**
 * Single attempt to extract background text from a PDF using the browser session
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} pdfRelativeUrl - Relative URL to the PDF
 * @returns {Promise<string>} - Extracted background text
 */
async function extractBackgroundFromPDFAttempt(driver, pdfRelativeUrl) {
    try {
        // Convert to direct PDF URL first
        const directPdfUrl = convertToDirectPDFUrl(pdfRelativeUrl);
        
        // Navigate to the PDF URL to trigger download
        const fullPdfUrl = directPdfUrl.startsWith('http') 
            ? directPdfUrl 
            : 'https://tampagov.hylandcloud.com' + directPdfUrl.replace(/&amp;/g, '&');
        
        // Get current cookies from the browser
        const cookies = await driver.manage().getCookies();
        
        // Create cookie string for axios
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        
        // Try to download with browser session
        const response = await axios.get(fullPdfUrl, {
            responseType: 'arraybuffer',
            timeout: 90000, // Increased to 90s for slow PDF loading days
            headers: {
                'User-Agent': await driver.executeScript('return navigator.userAgent'),
                'Cookie': cookieString,
                'Referer': await driver.getCurrentUrl()
            }
        });
        
        // Check if this is actually a PDF
        const pdfHeader = Buffer.from(response.data.slice(0, 10)).toString('ascii');
        if (!pdfHeader.startsWith('%PDF')) {
            return '';
        }
        
        // Suppress pdf-parse warnings (TT font warnings) by temporarily redirecting stderr
        const originalStderrWrite = process.stderr.write;
        process.stderr.write = () => {};

        // Parse the PDF
        const pdfData = await pdfParse(response.data);

        // Restore stderr
        process.stderr.write = originalStderrWrite;

        const text = pdfData.text;
        
        // Look for background section with specific patterns only
        const backgroundPatterns = [
            // Main background pattern - captures until common section headers
            /background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Background information variant
            /background\s*information\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Project background variant
            /project\s*background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Business case variant
            /business\s*case\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i
        ];
        
        for (const pattern of backgroundPatterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                let background = match[1].trim()
                    .replace(/[\f\r]/g, '') // Remove form feeds and carriage returns
                    .replace(/\s*\n\s*/g, '\n') // Normalize line breaks
                    .trim();
                
                // Format numbered lists properly
                background = formatBackgroundText(background);
                
                if (background.length > 20) {
                    return background;
                }
            }
        }
        
        return '';
        
    } catch (error) {
        console.error(`Error extracting background: ${error.message}`);
        return '';
    }
}

/**
 * Extract meeting date from the first summary sheet PDF
 * @param {Array} supportingDocs - Array of supporting documents for all items
 * @returns {Promise<string>} - Meeting date in MM/DD/YYYY format or empty string
 */
async function extractMeetingDateFromFirstPDF(supportingDocs) {
    try {
        // Find the first summary sheet PDF from any agenda item
        for (let i = 0; i < supportingDocs.length; i++) {
            const docs = supportingDocs[i];
            if (docs && docs.length > 0) {
                for (const doc of docs) {
                    if (doc.text && doc.text.toLowerCase().includes('summary sheet') && 
                        doc.href && doc.href.includes('.pdf')) {
                        
                        // Download and parse the PDF
                        const pdfUrl = doc.href.startsWith('http') ? 
                            doc.href : 
                            'https://tampagov.hylandcloud.com' + doc.href.replace(/&amp;/g, '&');
                        
                        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
                        
                        // Suppress pdf-parse warnings (TT font warnings) by temporarily redirecting stderr
                        const originalStderrWrite = process.stderr.write;
                        process.stderr.write = () => {};

                        const pdfData = await pdfParse(response.data);

                        // Restore stderr
                        process.stderr.write = originalStderrWrite;
                        
                        // console.log(`\n=== PDF Date Extraction Debug ===`);
                        // console.log(`PDF URL: ${pdfUrl}`);
                        // console.log(`PDF Text preview: ${pdfData.text.substring(0, 500)}...`);
                        
                        // Look for "Requested Meeting Date:" pattern
                        const dateMatch = pdfData.text.match(/Requested Meeting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                        if (dateMatch) {
                            // console.log(`Found "Requested Meeting Date": ${dateMatch[1]}`);
                            return dateMatch[1];
                        }
                        
                        // Alternative patterns if the main one doesn't work
                        const altDateMatch = pdfData.text.match(/Meeting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                        if (altDateMatch) {
                            // console.log(`Found "Meeting Date": ${altDateMatch[1]}`);
                            return altDateMatch[1];
                        }
                        
                        // Show all dates found for debugging
                        const allDates = pdfData.text.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
                        // console.log(`All dates found in PDF: ${allDates ? allDates.join(', ') : 'none'}`);
                        // console.log(`=== End PDF Debug ===\n`);
                    }
                }
            }
        }
        
        return '';
        
    } catch (error) {
        console.error('Error extracting meeting date from PDF:', error.message);
        return '';
    }
}

/**
 * Determine the financial entry type based on contextual text
 * @param {string[]} contexts - Array of contextual strings containing the amount
 * @param {string} section - Logical section name (e.g., projected_costs)
 * @returns {string} - Normalized type identifier
 */
function inferFinancialEntryType(contexts = [], section = '') {
    const combined = (contexts || [])
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    if (!combined && section === 'projected_costs') {
        return 'expenditure';
    }

    if (combined.includes('decrease') || combined.includes('deduct') || combined.includes('credit')) {
        return 'expenditure_decrease';
    }

    if (combined.includes('revenue') || combined.includes('income') || combined.includes('reimbursement')) {
        return 'revenue';
    }

    if (combined.includes('expenditure') || combined.includes('expense') || combined.includes('payment') || combined.includes('appropriation') || section === 'projected_costs') {
        return 'expenditure';
    }

    return 'unspecified';
}

/**
 * Parse the fiscal sections of a Summary Sheet PDF to extract structured entries
 * @param {string} summaryText - Full text extracted from the Summary Sheet PDF
 * @returns {Array<Object>} - Structured financial entries with amount, value, type, etc.
 */
function parseSummaryFinancialEntries(summaryText) {
    if (!summaryText) {
        return [];
    }

    const lines = summaryText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    const entries = [];
    let currentSection = '';
    let previousLine = '';

    for (const rawLine of lines) {
        const normalizedLine = rawLine.replace(/\s+/g, ' ');
        const upperLine = normalizedLine.toUpperCase();

        if (upperLine.startsWith('FISCAL IMPACT STATEMENT') || upperLine.startsWith('FISCAL IMPACT:')) {
            currentSection = 'fiscal_impact';
        } else if (upperLine.startsWith('PROJECTED COSTS')) {
            currentSection = 'projected_costs';
        } else if (upperLine.startsWith('FISCAL IMPACT')) {
            currentSection = 'fiscal_impact';
        }

        const amountMatches = normalizedLine.match(/\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g);
        if (amountMatches) {
            const contextParts = [normalizedLine];
            if (previousLine && !/\$\d/.test(previousLine)) {
                contextParts.push(previousLine);
            }
            const context = contextParts.join(' ').trim();
            const type = inferFinancialEntryType([context], currentSection);

            amountMatches.forEach(amount => {
                const numericValue = parseFloat(amount.replace(/[$,]/g, ''));
                entries.push({
                    amount,
                    value: Number.isFinite(numericValue) ? numericValue : 0,
                    type,
                    section: currentSection,
                    line: normalizedLine,
                    context
                });
            });
        }

        if (normalizedLine.length > 0) {
            previousLine = normalizedLine;
        }
    }

    return entries;
}

/**
 * Extract dollar amounts from agenda items text
 * @param {string} text - Agenda item text
 * @returns {Array<string>} - Array of dollar amounts found
 */
function extractDollarAmounts(text, options = {}) {
    const {
        additionalTexts = [],
        summaryText = '',
        summaryEntries = []
    } = options || {};

    const dollarRegex = /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
    const amountMap = new Map();

    const ensureEntry = (amount) => {
        if (!amountMap.has(amount)) {
            amountMap.set(amount, {
                amount,
                value: parseFloat(amount.replace(/[$,]/g, '')) || 0,
                type: null,
                section: null,
                contexts: [],
                sources: new Set()
            });
        }
        return amountMap.get(amount);
    };

    const appendDetail = (amount, detail = {}) => {
        const entry = ensureEntry(amount);
        if (detail.value !== undefined && Number.isFinite(detail.value)) {
            entry.value = detail.value;
        }
        if (detail.type) {
            if (!entry.type || entry.type === 'unspecified') {
                entry.type = detail.type;
            } else if (entry.type !== detail.type) {
                const contextLower = (detail.context || '').toLowerCase();
                if (contextLower.includes('expenditure decrease') || contextLower.includes('(expenditure decrease)')) {
                    entry.type = 'expenditure_decrease';
                } else if (contextLower.includes('(expenditure)') && !contextLower.includes('decrease')) {
                    entry.type = 'expenditure';
                } else if (detail.type === 'expenditure' && !contextLower.includes('decrease')) {
                    entry.type = 'expenditure';
                }
            }
        }
        if (detail.section && !entry.section) {
            entry.section = detail.section;
        }
        if (detail.context) {
            entry.contexts.push(detail.context);
        }
        if (detail.source) {
            entry.sources.add(detail.source);
        }
    };

    const processTextBlock = (block, sourceLabel) => {
        if (!block) return;
        const lines = block.split('\n');
        let previousLine = '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            const matches = line.match(dollarRegex);
            if (matches) {
                const context = `${previousLine} ${line}`.trim();
                const inferredType = inferFinancialEntryType([context]);
                matches.forEach(amount => {
                    appendDetail(amount, {
                        type: inferredType,
                        context,
                        source: sourceLabel
                    });
                });
            }

            previousLine = line;
        }
    };

    let parsedSummaryEntries = Array.isArray(summaryEntries) && summaryEntries.length > 0
        ? summaryEntries
        : parseSummaryFinancialEntries(summaryText);

    // Prioritize structured summary entries so they establish definitive types
    parsedSummaryEntries.forEach(entry => {
        appendDetail(entry.amount, {
            value: entry.value,
            type: entry.type,
            section: entry.section,
            context: entry.context,
            source: 'summary'
        });
    });

    // Process primary text and any additional blocks (e.g., descriptions, background)
    processTextBlock(text, 'primary');
    additionalTexts.forEach((block, index) => processTextBlock(block, `additional_${index}`));

    const details = Array.from(amountMap.values()).map(entry => {
        const contexts = entry.contexts;
        const inferredType = entry.type || inferFinancialEntryType(contexts, entry.section);
        const value = Number.isFinite(entry.value) ? entry.value : 0;
        let signedValue = 0;

        if (inferredType === 'expenditure') {
            signedValue = value;
        } else if (inferredType === 'expenditure_decrease' || inferredType === 'revenue') {
            signedValue = -value;
        }

        return {
            amount: entry.amount,
            value,
            signedValue,
            type: inferredType,
            section: entry.section,
            contexts,
            sources: Array.from(entry.sources)
        };
    });

    const totals = details.reduce((acc, detail) => {
        if (detail.type === 'expenditure') {
            acc.expenditures += detail.value;
            acc.net += detail.value;
        } else if (detail.type === 'expenditure_decrease') {
            acc.decreases += detail.value;
            acc.net -= detail.value;
        } else if (detail.type === 'revenue') {
            acc.revenues += detail.value;
            acc.net -= detail.value;
        } else {
            acc.other += detail.value;
        }
        return acc;
    }, { expenditures: 0, decreases: 0, revenues: 0, other: 0, net: 0 });

    return {
        amounts: details.map(detail => detail.amount),
        details,
        totals
    };
}

/**
 * Extract file number from agenda item text
 * @param {string} text - Agenda item text
 * @returns {string|null} - Extracted file number or null if not found
 */
function extractFileNumber(text) {
    if (!text) return null;

    const normalizeFileNumber = (value) =>
        value
            .replace(/\s*-\s*/g, '-')
            .replace(/\s*\/\s*/g, '/')
            .replace(/\s+/g, ' ')
            .trim();

    const patterns = [
        // Standard "File No." prefix with flexible separators/spaces
        /File\s+No\.?\s+([A-Z]{1,5}(?:\s*\d{1,4})?(?:\s*[-\/]\s*[A-Z\d]{1,8})*)/i,
        // TA/CPA special case that sometimes lacks the "File No." prefix
        /\b(TA\/CPA\d{1,4}\s*[-\/]\s*\d{1,6})\b/i,
        // REZ/CPA/PD cases with optional separators
        /\b((?:REZ|CPA|PD)\s*[-\/]?\d{2,4}\s*[-\/]\s*\d{1,6}(?:\s*[-\/]\s*[A-Z\d]+)*)\b/i,
        // General direct file number pattern (captures CM25-12001, FDN 25-36-C, etc.)
        /\b([A-Z]{1,5}(?:\s*\d{1,4})?(?:\s*[-\/]\s*[A-Z\d]{1,8})+)\b/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            return normalizeFileNumber(match[1]);
        }
    }
    
    // Pattern 2: Direct file number pattern (for items without "File No." prefix)
    // Matches patterns like CM25-13759, E2025-15, PS25-15649, FDN 25-36-C, etc.
    const directFileMatch = text.match(/^([A-Z]{1,5}\d{2,4}-\d{2,6}(?:-[A-Z])?)/i);
    if (directFileMatch) {
        return directFileMatch[1];
    }

    if (/Administration Update/i.test(text)) {
        return 'Administration Update';
    }

    return null;
}

/**
 * Main scraping function
 * @param {string} url - URL to scrape
 * @param {string} meetingId - Meeting ID
 * @returns {Promise<boolean>} - Success status
 */
async function scrapeWithSelenium(url, meetingId, meetingType = 'regular') {
    let driver = await new Builder().forBrowser('chrome').build();
    try {
        await driver.get(url);
        
        // Wait for the page to fully load and JavaScript to execute
        await new Promise(res => setTimeout(res, 5000)); // Initial wait
        
        // Get the full page source after JavaScript execution
        let pageSource = await driver.getPageSource();
        
        // Load the page source into cheerio
        const $ = cheerio.load(pageSource);
        
        // Extract meeting date from the page
        let meetingDate = '';
        // Look for various possible date selectors
        const dateSelectors = [
            '#lblMeetingDate',
            '.meeting-date',
            '[id*="date"]',
            '[class*="date"]'
        ];
        
        for (const selector of dateSelectors) {
            const dateElement = $(selector);
            if (dateElement.length > 0) {
                meetingDate = dateElement.text().trim();
                if (meetingDate && meetingDate.length > 5) {
                    break;
                }
            }
        }
        
        // If no date found in selectors, try to find it in the page title or text
        if (!meetingDate) {
            const pageTitle = $('title').text();
            const dateMatch = pageTitle.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2}, \d{4})/);
            if (dateMatch) {
                meetingDate = dateMatch[1];
            }
        }
        
        // Look for date in h1 elements (for evening agendas)
        if (!meetingDate) {
            $('h1').each((i, el) => {
                const text = $(el).text().trim();
                // Look for patterns like "Thursday, July 24, 2025"
                const dateMatch = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
                if (dateMatch) {
                    meetingDate = dateMatch[1];
                    return false; // break out of each loop
                }
                // Also look for MM/DD/YYYY patterns
                const numericDateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                if (numericDateMatch) {
                    meetingDate = numericDateMatch[1];
                    return false;
                }
            });
        }
        
        // Look for date in span elements as fallback
        if (!meetingDate) {
            $('span').each((i, el) => {
                const text = $(el).text().trim();
                // Look for patterns like "Thursday, July 24, 2025"
                const dateMatch = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
                if (dateMatch) {
                    meetingDate = dateMatch[1];
                    return false; // break out of each loop
                }
            });
        }
        
        // Extract agenda type (DRAFT or FINAL) from the h1 header
        // The header contains spaced-out text like "R E G U L A R   F I N A L   A G E N D A"
        let agendaType = 'DRAFT'; // Default to DRAFT
        $('h1').each((i, el) => {
            const text = $(el).text().trim();
            // Remove all spaces to normalize the text
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
        console.log(`Detected agenda type: ${agendaType}`);
        
        // Enhanced table-based agenda item parsing
        // This replaces the old link-based approach to catch both linked and unlinked items
        let agendaItems = [];
        
        console.log('Using enhanced table-based agenda item parsing...');
        
        // Target tables with the specific indented structure for agenda items
        $('table[style*="margin-left:30.6pt"]').each((index, table) => {
            const $table = $(table);
            const $firstRow = $table.find('tbody > tr').first();
            const $cells = $firstRow.find('td');
            
            if ($cells.length >= 2) {
                const $numberCell = $cells.eq(0);
                const $contentCell = $cells.eq(1);
                
                // Extract item number from first cell
                const numberText = $numberCell.text().trim();
                const numberMatch = numberText.match(/^(\d+)\./);
                
                if (numberMatch) {
                    const itemNumber = parseInt(numberMatch[1]);
                    const contentText = $contentCell.text().trim();
                    
                    // Enhanced file number extraction patterns
                    const fileNumberPatterns = [
                        // Standard "File No. ABC123-456" (most common) - handles spaces and various suffixes
                        /File\s+No\.\s+([A-Z]{1,5}\s*\d*\s*[-\/]?\s*\d{1,4}\s*[-\/]?\s*\d{0,6}(?:\s*[-\/]\s*[A-Z\d]*)?(?:\s+\([^)]*\))?)/i,
                        // Missing "File No." prefix - handles patterns like "FDN 25-36-C"
                        /^([A-Z]{2,5}\s*\d{0,3}\s*[-\/]\s*\d{1,4}\s*[-\/]\s*(?:\d{1,6}|[A-Z])(?:\s*[-\/]\s*[A-Z])?)/i,
                        // Comprehensive plan amendments (TA/CPA format)
                        /(?:File\s+No\.?\s+)?(TA\/CPA\d{2,4}[-\/]\d{1,6})/i,
                        // Other special formats like B2020-10
                        /(?:File\s+No\.?\s+)?([A-Z]{1,5}\d{2,4}[-\/]\d{1,6})/i,
                        // REZ, CPA, PD patterns
                        /(?:File\s+No\.?\s+)?((REZ|CPA|PD)[-\/]?\d{2,4}[-\/]\d{1,6})/i
                    ];
                    
                    let fileNumber = null;
                    let rawFileNumber = null;
                    
                    for (const pattern of fileNumberPatterns) {
                        const match = contentText.match(pattern);
                        if (match) {
                            fileNumber = match[1].trim();
                            rawFileNumber = contentText; // Keep full text for legacy compatibility
                            break;
                        }
                    }
                    
                    // Handle special cases like "Administration Update"
                    if (!fileNumber && contentText.includes('Administration Update')) {
                        fileNumber = 'Administration Update';
                        rawFileNumber = contentText;
                    }
                    
                    if (fileNumber) {
                        // Extract link information (for linked items)
                        const $link = $contentCell.find('a[id^="lnkAgendaItem_"]');
                        const isLinked = $link.length > 0;
                        let agendaItemId = null;
                        
                        // Extract agenda item ID from name attribute
                        const $nameAnchor = $contentCell.find('a[name]');
                        if ($nameAnchor.length > 0) {
                            const nameId = $nameAnchor.attr('name');
                            const idMatch = nameId.match(/^I(\d+)$/);
                            if (idMatch) {
                                agendaItemId = idMatch[1];
                            }
                        }
                        
                        // If no agendaItemId from name, try to extract from href
                        if (!agendaItemId && isLinked) {
                            const href = $link.attr('href');
                            const hrefMatch = href && href.match(/loadAgendaItem\((\d+),/);
                            if (hrefMatch) {
                                agendaItemId = hrefMatch[1];
                            }
                        }
                        
                        agendaItems.push({
                            number: itemNumber,
                            agendaItemId: agendaItemId,
                            fileNumber: rawFileNumber || fileNumber, // Use full text for legacy compatibility
                            id: isLinked ? $link.attr('id') : null,
                            href: isLinked ? $link.attr('href') : null,
                            isUnlinked: !isLinked,
                            extractedFileNumber: fileNumber // Clean file number for processing
                        });
                        
                        if (!isLinked) {
                            // console.log(`Found unlinked agenda item ${itemNumber}: ${fileNumber}`);
                        }
                    }
                }
            }
        });
        
        // Sort by item number to ensure proper order
        agendaItems.sort((a, b) => a.number - b.number);
        
        console.log(`Enhanced parsing found ${agendaItems.length} agenda items`);
        
        // Debug: Show first few agenda items to verify parsing
        console.log(`\n=== First 5 Agenda Items (Debug) ===`);
        agendaItems.slice(0, 5).forEach(item => {
            console.log(`  ${item.number}: ID=${item.agendaItemId}, FileNum="${item.extractedFileNumber}", Original="${item.fileNumber}"`);
        });
        
        const unlinkedItems = agendaItems.filter(item => item.isUnlinked);
        if (unlinkedItems.length > 0) {
            // console.log(`Found ${unlinkedItems.length} unlinked items:`);
            // unlinkedItems.forEach(item => {
            //     console.log(`  Item ${item.number}: ${item.extractedFileNumber}`);
            // });
        }
        
        if (agendaItems.length === 0) {
            console.error(`No agenda items found for meeting ${meetingId}`);
            return false;
        }

        // Try to find item IDs by scanning the document for supporting document links that contain itemId parameters
        const supportingDocLinks = $('a[href*="DownloadFile"]');
        const itemIdMap = {};
        
        // Group supporting document links by their itemId
        const itemIdToFileNumbers = {};
        
        supportingDocLinks.each((index, link) => {
            const href = $(link).attr('href');
            if (href) {
                const itemIdMatch = href.match(/itemId=(\d+)/);
                if (itemIdMatch && itemIdMatch[1]) {
                    const itemId = itemIdMatch[1];
                    const text = $(link).text().trim();
                    
                    // Collect all document texts for this itemId
                    if (!itemIdToFileNumbers[itemId]) {
                        itemIdToFileNumbers[itemId] = [];
                    }
                    itemIdToFileNumbers[itemId].push(text);
                    
                    // Also try to extract file number from URL patterns
                    const fileNumberMatch = href.match(/File_([A-Za-z0-9-_]+)\.pdf/i) || 
                                           href.match(/\/([A-Za-z0-9-_]+)_\d+_/i);
                    
                    if (fileNumberMatch && fileNumberMatch[1]) {
                        let fileNumberPart = fileNumberMatch[1].replace(/_/g, '/');
                        // Map the item ID to the file number for later matching
                        itemIdMap[fileNumberPart.toUpperCase()] = itemId;
                    }
                }
            }
        });

        // Update agenda items with the extracted item IDs (for items that don't already have them)
        for (let item of agendaItems) {
            if (!item.agendaItemId) {
                // Use the extracted clean file number for matching
                const fileNumberForMatching = item.extractedFileNumber || item.fileNumber;
                let fileNumberPart = '';
                
                // Extract just the file number part for matching
                if (fileNumberForMatching.startsWith('File No.')) {
                    fileNumberPart = fileNumberForMatching.substring(9).trim().toUpperCase();
                } else {
                    fileNumberPart = fileNumberForMatching.toUpperCase();
                }
                
                // Method 1: Direct matching using file number extracted from URLs
                for (const [key, id] of Object.entries(itemIdMap)) {
                    if (fileNumberPart.includes(key) || key.includes(fileNumberPart)) {
                        item.agendaItemId = id;
                        break;
                    }
                }
                
                // Method 2: If still no match, try using the collected document texts
                if (!item.agendaItemId) {
                    for (const [itemId, texts] of Object.entries(itemIdToFileNumbers)) {
                        // Check if any of the texts contain the file number
                        const matchingText = texts.find(text => {
                            return text.toUpperCase().includes(fileNumberPart) || 
                                  fileNumberPart.includes(text.toUpperCase());
                        });
                        
                        if (matchingText) {
                            item.agendaItemId = itemId;
                            break;
                        }
                    }
                }
                
                // If we're still unable to find the ID, use a more aggressive matching approach
                if (!item.agendaItemId) {
                    // Convert File No. AB2-25-04 to just AB2-25-04 or ab2-25-04
                    const cleanFileNumber = fileNumberPart.replace(/[^A-Za-z0-9-]/g, '');
                    
                    for (const [itemId, texts] of Object.entries(itemIdToFileNumbers)) {
                        for (const text of texts) {
                            const cleanText = text.toUpperCase().replace(/[^A-Za-z0-9-]/g, '');
                            if (cleanText.includes(cleanFileNumber) || cleanFileNumber.includes(cleanText)) {
                                item.agendaItemId = itemId;
                                break;
                            }
                        }
                        if (item.agendaItemId) break;
                    }
                }
            }
        }
        
        // Extract agenda item IDs for debugging
        // console.log('Extracted agenda item IDs:');
        // for (const item of agendaItems) {
        //     console.log(`File No. ${item.fileNumber}: Item ID = ${item.agendaItemId || 'Not found'}`);
        // }
        
        // Now load each agenda item directly using IDs - much faster than clicking
        let processedItems = [];
        
        for (let i = 0; i < agendaItems.length; i++) {
            const item = agendaItems[i];
            
            // Simple progress indicator
            if (i % 5 === 0 || i === agendaItems.length - 1) {
                console.log(`Processing agenda items ${i+1}-${Math.min(i+5, agendaItems.length)} of ${agendaItems.length}...`);
            }
            
            try {
                // Skip items without agendaItemId (shouldn't happen with enhanced matching)
                if (!item.agendaItemId) {
                    console.log(`Warning: No agenda item ID found for item ${item.number}: ${item.fileNumber}`);
                    
                    const basicDollarInfo = extractDollarAmounts(item.fileNumber);

                    // Create basic item object for items without IDs
                    const processedItem = {
                        number: item.number,
                        agendaItemId: null,
                        fileNumber: item.extractedFileNumber || extractFileNumber(item.fileNumber) || item.fileNumber,
                        title: item.fileNumber,
                        rawTitle: item.fileNumber,
                        background: "",
                        supportingDocuments: [],
                        dollarAmounts: basicDollarInfo.amounts,
                        financialDetails: basicDollarInfo.details,
                        financialTotals: basicDollarInfo.totals
                    };

                    processedItems.push(processedItem);
                    continue;
                }
                
                // Load agenda item directly using ID - no clicking required!
                await driver.executeScript(`loadAgendaItem(${item.agendaItemId}, false);`);
                
                // Wait for content with reasonable timeout
                await driver.wait(until.elementLocated(By.css('#itemView')), 15000);
                await new Promise(res => setTimeout(res, 1500));
                
                // Simple content validation
                await driver.wait(async () => {
                    const html = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                    return html && html.trim().length > 100 && html.includes('item-view-title-text');
                }, 15000);
                
                // Get content
                const itemViewHtml = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                const $itemView = cheerio.load(itemViewHtml);
                
                // Extract the full description
                const fullDescription = $itemView('.item-view-title-text').text().trim();
                const finalItemText = fullDescription || item.fileNumber;
                
                // Extract file number from content, with fallback to original fileNumber
                let fileNo = extractFileNumber(finalItemText);
                if (!fileNo && item.fileNumber) {
                    fileNo = extractFileNumber(item.fileNumber) || item.fileNumber.replace('File No. ', '');
                }
                
                // Extract supporting document links and update agendaItemId if needed
                const docLinks = [];
                let summarySheetLink = null;
                
                $itemView('a[href*="DownloadFile"]').each((j, docLink) => {
                    const $docLink = $itemView(docLink);
                    const href = $docLink.attr('href');
                    const title = $docLink.attr('title') || '';
                    const text = $docLink.text().trim();
                    
                    if (href) {
                        // Update the agendaItemId from the document URLs if we didn't have it before
                        if (!item.agendaItemId) {
                            const itemIdMatch = href.match(/itemId=(\d+)/);
                            if (itemIdMatch && itemIdMatch[1]) {
                                item.agendaItemId = itemIdMatch[1];
                            }
                        }
                        
                        // Convert to direct download URL for PDFs
                        const directHref = convertToDirectPDFUrl(href);
                        // Create absolute URL
                        const fullUrl = directHref.startsWith('http') ? 
                            directHref : 
                            'https://tampagov.hylandcloud.com' + directHref.replace(/&amp;/g, '&');
                        
                        const docInfo = { 
                            title: toTitleCase(text || title || 'Document'),
                            url: fullUrl,
                            originalText: text,
                            originalTitle: title
                        };
                        docLinks.push(docInfo);
                        
                        // Track Summary Sheet for background extraction
                        if (text.toLowerCase().includes('summary sheet') && 
                            text.toLowerCase().includes('cover sheet')) {
                            summarySheetLink = docInfo;
                        }
                    }
                });
                
                // Try to extract background from Summary Sheet PDF if available
                let backgroundText = '';
                if (summarySheetLink) {
                    try {
                        backgroundText = await extractBackgroundFromPDFWithBrowser(driver, summarySheetLink.url);
                        if (backgroundText) {
                            console.log(`✓ Background extracted for item ${i+1} (${backgroundText.length} chars)`);
                        }
                    } catch (err) {
                        console.log(`⚠️  Background extraction failed for item ${i+1}: ${err.message.split(':')[0]}`);
                        backgroundText = '';
                    }
                }
                
                const primaryDollarInfo = extractDollarAmounts(finalItemText);
                
                // Note: fileNo was already extracted above in the content validation section
                
                // Extract item ID from supporting document URLs if not already set
                let finalAgendaItemId = item.agendaItemId;
                if (!finalAgendaItemId && docLinks.length > 0) {
                    for (const doc of docLinks) {
                        const itemIdMatch = doc.url.match(/itemId=(\d+)/);
                        if (itemIdMatch && itemIdMatch[1]) {
                            finalAgendaItemId = itemIdMatch[1];
                            // console.log(`Found item ID ${finalAgendaItemId} from supporting document URL for ${fileNo}`);
                            break;
                        }
                    }
                }
                
                // Create a structured object for this item - store only raw text, clean during WordPress generation
                const itemObject = {
                    number: i + 1,
                    agendaItemId: finalAgendaItemId,
                    fileNumber: fileNo,
                    title: finalItemText.trim(), // Keep title for compatibility with staff-report-parser
                    rawTitle: finalItemText.trim(), // Store raw text - will be cleaned during WordPress generation
                    background: backgroundText,
                    supportingDocuments: docLinks,
                    dollarAmounts: primaryDollarInfo.amounts,
                    financialDetails: primaryDollarInfo.details,
                    financialTotals: primaryDollarInfo.totals
                };
                
                processedItems.push(itemObject);
                
            } catch (err) {
                console.error(`Error extracting Item Details for agenda item ${i+1} (${item.fileNumber}): ${err.message}`);
                
                // Provide more detailed error information
                if (err.message.includes('timeout') || err.message.includes('timed out')) {
                    console.error(`  → This appears to be a timeout error. The webpage or PDF may be loading slowly.`);
                } else if (err.message.includes('element not found') || err.message.includes('no such element')) {
                    console.error(`  → This appears to be a page structure issue. The expected elements may not be present.`);
                }
                
                console.log(`  → Creating basic fallback item for agenda item ${i+1}`);
                
                // Create a basic object with just the file number information
                processedItems.push({
                    number: i + 1,
                    agendaItemId: item.agendaItemId, // Keep original ID if available
                    fileNumber: item.fileNumber.replace('File No. ', ''),
                    title: item.fileNumber,
                    rawTitle: item.fileNumber,
                    background: '',
                    supportingDocuments: [],
                    dollarAmounts: [],
                    financialDetails: [],
                    financialTotals: { expenditures: 0, decreases: 0, revenues: 0, other: 0, net: 0 },
                    processingError: err.message // Track what went wrong for debugging
                });
            }
        }
        
        // Extract meeting date - try HTML first, then fall back to PDF
        let meetingDateStr = meetingDate; // Use the date extracted from HTML
        console.log(`\n=== Meeting Date Extraction ===`);
        console.log(`HTML extracted date: "${meetingDate}"`);
        
        // If no date found in HTML, try PDF extraction as fallback
        if (!meetingDateStr) {
            console.log('No date found in HTML, trying PDF extraction...');
            // Create array of supporting docs for each item
            const supportingDocs = processedItems.map(item => 
                item.supportingDocuments.map(doc => ({
                    text: doc.originalText,
                    href: doc.url
                }))
            );
            meetingDateStr = await extractMeetingDateFromFirstPDF(supportingDocs);
            console.log(`PDF extracted date: "${meetingDateStr}"`);
        }
        
        // Create structured JSON object
        const meetingData = {
            meetingId: meetingId,
            meetingType: meetingType, // Use the provided meeting type from the main page
            agendaType: agendaType, // DRAFT or FINAL
            meetingDate: meetingDateStr,
            formattedDate: formatDateForFilename(meetingDateStr),
            sourceUrl: url,
            agendaItems: processedItems
        };
        
        const hasFinancialDetails = meetingData.agendaItems.some(item => {
            return Array.isArray(item.financialDetails) && item.financialDetails.length > 0;
        });

        if (hasFinancialDetails) {
            const aggregate = { expenditures: 0, decreases: 0, revenues: 0, other: 0, net: 0 };

            meetingData.agendaItems.forEach(item => {
                const totals = item.financialTotals || { expenditures: 0, decreases: 0, revenues: 0, other: 0, net: 0 };
                aggregate.expenditures += totals.expenditures || 0;
                aggregate.decreases += totals.decreases || 0;
                aggregate.revenues += totals.revenues || 0;
                aggregate.other += totals.other || 0;
                aggregate.net += totals.net || 0;
            });

            const formatCurrency = (value) => {
                if (!Number.isFinite(value)) {
                    return null;
                }
                const abs = Math.abs(value);
                const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return `${value < 0 ? '-' : ''}$${formatted}`;
            };

            meetingData.totalExpenditureAmount = aggregate.expenditures;
            meetingData.totalExpenditureDecreaseAmount = aggregate.decreases;
            meetingData.totalRevenueAmount = aggregate.revenues;
            meetingData.totalOtherFinancialAmount = aggregate.other;
            meetingData.totalDollarAmount = aggregate.net;

            meetingData.formattedTotalExpenditureAmount = formatCurrency(aggregate.expenditures);
            meetingData.formattedTotalExpenditureDecreaseAmount = formatCurrency(-aggregate.decreases);
            meetingData.formattedTotalRevenueAmount = formatCurrency(-aggregate.revenues);
            meetingData.formattedTotalOtherFinancialAmount = formatCurrency(aggregate.other);
            meetingData.formattedTotalDollarAmount = formatCurrency(aggregate.net);

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
                    expenditures: meetingData.formattedTotalExpenditureAmount,
                    decreases: meetingData.formattedTotalExpenditureDecreaseAmount,
                    revenues: meetingData.formattedTotalRevenueAmount,
                    other: meetingData.formattedTotalOtherFinancialAmount,
                    net: meetingData.formattedTotalDollarAmount
                },
                expenditureRange
            };
        }
        
        // Process staff reports and integrate into agenda items
        await integrateStaffReportsIntoAgendaItems(meetingData);
        
        // Save the JSON data
        const outputDir = path.join(__dirname, 'data');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }

        // Create filename with meeting date if available
        let fileName = `meeting_${meetingId}`;
        if (meetingData.formattedDate) {
            fileName = `meeting_${meetingId}_${meetingData.formattedDate}`;
        }
        
        // Processing summary
        const successfulItems = processedItems.filter(item => !item.processingError);
        const failedItems = processedItems.filter(item => item.processingError);
        const itemsWithBackground = processedItems.filter(item => item.background && item.background.length > 0);
        
        console.log(`\n=== Processing Summary ===`);
        console.log(`Total agenda items: ${processedItems.length}`);
        console.log(`Successfully processed: ${successfulItems.length}`);
        console.log(`Failed with errors: ${failedItems.length}`);
        console.log(`Items with background extracted: ${itemsWithBackground.length}`);
        
        if (failedItems.length > 0) {
            console.log(`\nFailed items:`);
            failedItems.forEach(item => {
                console.log(`  - Item ${item.number}: ${item.fileNumber} (${item.processingError})`);
            });
        }
        
        const outputFileName = path.join(outputDir, `${fileName}.json`);
        fs.writeFileSync(outputFileName, JSON.stringify(meetingData, null, 2));
        
        console.log(`Successfully created JSON: ${outputFileName}`);
        
        return true;
    } catch (error) {
        console.error(`Error scraping meeting ${meetingId}:`, error);
        return false;
    } finally {
        await driver.quit();
    }
}

/**
 * Detect meeting type (regular, evening, special, etc.)
 * @param {CheerioAPI} $ - Cheerio instance loaded with page HTML
 * @returns {string} - Meeting type
 */
function detectMeetingType($) {
    // Find the CITY OF TAMPA h1
    const cityTampaH1 = $('h1').filter(function() {
        return $(this).text().trim() === 'CITY OF TAMPA';
    });
    
    // Default meeting type if structure not found
    let meetingType = 'regular';
    
    if (cityTampaH1.length > 0) {
        // Get the next h1 element
        const nextH1 = cityTampaH1.next('h1');
        if (nextH1.length > 0) {
            // Use the exact text content as the meeting type
            const rawText = nextH1.text().trim();
            if (rawText) {
                meetingType = rawText;
            }
        }
    }
    
    return meetingType;
}

/**
 * Scrape meeting IDs and types from the main page
 * @param {string} url - URL of the main page
 * @returns {Promise<Array<Object>>} - Array of meeting objects with ID and type
 */
async function scrapeMeetingIds(url) {
    // Set up the Selenium WebDriver
    let driver = await new Builder().forBrowser('chrome').build();
    
    try {
        // Load the page
        await driver.get(url);
        
        // Wait for the #meetings-list-upcoming element to be loaded
        await driver.wait(until.elementLocated(By.id('meetings-list-upcoming')), 20000);
        
        // Extract the page source
        let pageSource = await driver.getPageSource();
        
        // Load the page source into cheerio
        const $ = cheerio.load(pageSource);
        
        // Find all unique data-meeting-id attributes for <tr> where the last <td> includes an "Agenda" href (not "Summary")
        let meetingData = [];
        $('#meetings-list-upcoming table:first-of-type tr').each((i, tr) => {
            let $tr = $(tr);
            let lastTd = $tr.find('td').last();
            let links = lastTd.find('a[href]');
            
            // Check if any link in this row contains "Agenda" and NOT "Summary"
            let hasAgendaLink = false;
            links.each((j, link) => {
                let linkText = $(link).text().trim().toLowerCase();
                let linkHref = $(link).attr('href') || '';
                
                // Include if:
                // 1. Link text contains "agenda" but not "summary"
                // 2. Link href contains "doctype=1" (which is agenda) but text doesn't contain "summary"
                if ((linkText.includes('agenda') && !linkText.includes('summary')) ||
                    (linkHref.includes('doctype=1') && !linkText.includes('summary'))) {
                    hasAgendaLink = true;
                }
            });
            
            if (hasAgendaLink) {
                let meetingId = $tr.attr('data-meeting-id');
                if (meetingId) {
                    // Explicitly exclude known summary meeting IDs
                    if (meetingId === '2651') {
                        // Skip summary meetings
                    } else {
                        // Extract the meeting type from the mtgType column
                        let meetingType = 'regular'; // Default value
                        
                        // Find the cell with data-sortable-type="mtgType"
                        const mtgTypeCell = $tr.find('td[data-sortable-type="mtgType"]');
                        if (mtgTypeCell.length > 0) {
                            meetingType = mtgTypeCell.text().trim();
                        }
                        
                        // Add the meeting data to our collection
                        meetingData.push({
                            id: meetingId,
                            type: meetingType
                        });
                    }
                }
            }
        });
        
        return meetingData;
    } finally {
        // Quit the driver
        await driver.quit();
    }
}

/**
 * Scrape meeting using HTTP (default method)
 * @param {string} meetingId - Meeting ID
 * @param {string} meetingType - Meeting type
 * @param {Object} session - Axios session (optional)
 * @returns {Promise<void>}
 */
async function scrapeWithHTTP(meetingId, meetingType = 'regular', session = null) {
    console.log(`\n[HTTP] Starting scrape for meeting ${meetingId} (${meetingType})`);
    
    try {
        // Fetch meeting data using HTTP module
        const meetingData = await fetchMeeting(meetingId, meetingType, {
            session,
            saveDebugFiles: true,
            extractFileNumber,
            extractDollarAmounts,
            formatBackgroundText,
            parseSummaryFinancialEntries
        });

        // Integrate staff reports if available
        if (meetingData.agendaItems && meetingData.agendaItems.length > 0) {
            // Pass the entire meetingData object, not just agendaItems
            await integrateStaffReportsIntoAgendaItems(meetingData);
        }

        // Add formattedDate to meetingData for WordPress converter compatibility
        meetingData.formattedDate = formatDateForFilename(meetingData.meetingDate);
        const dateString = meetingData.formattedDate || 'unknown-date';

        // Save to JSON file
        const filename = path.join(__dirname, 'data', `meeting_${meetingId}_${dateString}.json`);
        
        // Ensure data directory exists
        if (!fs.existsSync(path.join(__dirname, 'data'))) {
            fs.mkdirSync(path.join(__dirname, 'data'));
        }

        fs.writeFileSync(filename, JSON.stringify(meetingData, null, 2));
        console.log(`[HTTP] ✅ Meeting ${meetingId} saved to: ${filename}`);
        
        // Print summary
        console.log(`[HTTP] Summary: ${meetingData.agendaItems.length} items, date: ${meetingData.meetingDate}`);
        if (meetingData.financialSummary) {
            console.log(`[HTTP] Financial net: ${meetingData.financialSummary.formatted.net}`);
        }
    } catch (error) {
        console.error(`[HTTP] ❌ Failed to scrape meeting ${meetingId}:`, error.message);
        throw error;
    }
}

/**
 * Main function
 */
async function main() {
    // Check if a specific meeting ID was provided as command line argument
    const args = process.argv.slice(2);
    
    // Check for --selenium flag
    const useSelenium = args.includes('--selenium');
    const filteredArgs = args.filter(arg => arg !== '--selenium');
    const specificMeetingId = filteredArgs[0];
    
    console.log(`\n🚀 Tampa Agenda Scraper`);
    console.log(`Engine: ${useSelenium ? 'Selenium (legacy)' : 'HTTP (default)'}\n`);
    
    // URL of the page to scrape for meeting IDs
    let url = 'https://tampagov.hylandcloud.com/221agendaonline/';
    
    if (useSelenium) {
        // Legacy Selenium path
        if (specificMeetingId) {
            // For specific meeting ID, we still need to get its meeting type from the main page
            const meetingData = await scrapeMeetingIds(url);
            const meetingInfo = meetingData.find(meeting => meeting.id === specificMeetingId);
            const meetingType = meetingInfo ? meetingInfo.type : 'regular';
            
            // Process single meeting with its type
            const meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${specificMeetingId}&doctype=1`;
            await scrapeWithSelenium(meetingUrl, specificMeetingId, meetingType);
            return;
        }
        
        // Get meetings with their IDs and types
        let meetingsData = await scrapeMeetingIds(url);
        
        // Scrape each meeting ID sequentially
        for (let meeting of meetingsData) {
            // Use the correct rendered agenda URL
            let meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${meeting.id}&doctype=1`;
            await scrapeWithSelenium(meetingUrl, meeting.id, meeting.type);
        }
    } else {
        // HTTP path (default)
        const session = await createSession();
        
        if (specificMeetingId) {
            // For specific meeting ID, fetch its type from the meeting list
            console.log(`[HTTP] Fetching meeting type for ID ${specificMeetingId}...`);
            const meetings = await fetchMeetingList({ session });
            const meetingInfo = meetings.find(m => m.id === specificMeetingId);
            const meetingType = meetingInfo ? meetingInfo.type : 'regular';
            
            // Process single meeting
            await scrapeWithHTTP(specificMeetingId, meetingType, session);
            return;
        }
        
        // Get meetings with their IDs and types
        const meetings = await fetchMeetingList({ session });
        console.log(`[HTTP] Found ${meetings.length} meetings to process\n`);
        
        // Scrape each meeting sequentially
        for (let i = 0; i < meetings.length; i++) {
            const meeting = meetings[i];
            console.log(`[HTTP] Processing meeting ${i + 1}/${meetings.length}: ${meeting.id} (${meeting.type})`);
            await scrapeWithHTTP(meeting.id, meeting.type, session);
        }
        
        console.log(`\n[HTTP] ✅ All ${meetings.length} meetings processed successfully`);
    }
}

// Call the main function
if (require.main === module) {
    main();
}

// Export functions for testing
module.exports = {
    scrapeMeetingIds,
    scrapeWithSelenium,
    scrapeWithHTTP,
    extractBackgroundFromPDFWithBrowser,
    extractFileNumber,
    extractDollarAmounts,
    parseSummaryFinancialEntries,
    formatBackgroundText
};

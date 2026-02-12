const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');

/**
 * Select the most recent staff report when multiple exist
 * @param {Array} staffReports - Array of staff report documents
 * @returns {Array} - Array with the most recent staff report
 */
function selectMostRecentStaffReport(staffReports) {
    if (staffReports.length <= 1) {
        return staffReports;
    }
    
    console.log(`   🔍 Found ${staffReports.length} staff reports, selecting most recent...`);
    
    // Sort by date in filename (if present), otherwise by title
    const sortedReports = staffReports.sort((a, b) => {
        // Extract dates from filenames (look for MM.DD.YY or MM.DD.YYYY patterns)
        const datePatternA = a.title.match(/(\d{2})\.(\d{2})\.(\d{2,4})/);
        const datePatternB = b.title.match(/(\d{2})\.(\d{2})\.(\d{2,4})/);
        
        if (datePatternA && datePatternB) {
            // Both have dates, compare them
            const [, monthA, dayA, yearA] = datePatternA;
            const [, monthB, dayB, yearB] = datePatternB;
            
            // Convert 2-digit years to 4-digit (assuming 20xx)
            const fullYearA = yearA.length === 2 ? `20${yearA}` : yearA;
            const fullYearB = yearB.length === 2 ? `20${yearB}` : yearB;
            
            const dateA = new Date(`${fullYearA}-${monthA}-${dayA}`);
            const dateB = new Date(`${fullYearB}-${monthB}-${dayB}`);
            
            return dateB - dateA; // Most recent first
        } else if (datePatternA) {
            // A has date, B doesn't - A is more recent
            return -1;
        } else if (datePatternB) {
            // B has date, A doesn't - B is more recent
            return 1;
        } else {
            // Neither has date, sort alphabetically (longer titles often indicate updates)
            return b.title.length - a.title.length;
        }
    });
    
    const selectedReport = sortedReports[0];
    console.log(`   ✅ Selected: ${selectedReport.title}`);
    
    if (sortedReports.length > 1) {
        console.log(`   ⚠️  Skipped: ${sortedReports.slice(1).map(r => r.title).join(', ')}`);
    }
    
    return [selectedReport];
}

/**
 * Identify agenda items with staff reports and extract the documents
 * @param {object} meetingData - The parsed meeting JSON data
 * @returns {Array} - Array of items with staff report documents
 */
function identifyStaffReports(meetingData) {
    const staffReportItems = [];
    
    meetingData.agendaItems.forEach(item => {
        // Check for land use cases by identifying common patterns:
        // 1. File number starting with REZ-, VAC-, SU-, etc.
        // 2. Presence of staff report documents
        // 3. Title starting with "File No." pattern
        const itemTitle = item.title || item.rawTitle || '';
        const fileNumber = item.fileNumber || '';
        
        // Check if this is a land use case by file number pattern
        const isLandUseCase = /^(REZ|VAC|SU|TA\/CPA|CPA|PD)-/i.test(fileNumber) ||
                             fileNumber.includes('TA/CPA');
        
        // Also check if title starts with "File No." (common for land use cases)
        const hasFileNoFormat = itemTitle.startsWith('File No. ') && itemTitle.includes(fileNumber);
        
        if ((isLandUseCase || hasFileNoFormat) && item.supportingDocuments) {
            // Look for staff report final documents
            const staffReports = item.supportingDocuments.filter(doc => 
                doc.title.toUpperCase().includes('STAFF REPORT FINAL')
            );
            
            if (staffReports.length > 0) {
                // Select the most recent staff report if multiple exist
                const selectedStaffReports = selectMostRecentStaffReport(staffReports);
                
                staffReportItems.push({
                    agendaItemId: item.agendaItemId,
                    fileNumber: item.fileNumber,
                    title: itemTitle,
                    staffReports: selectedStaffReports,
                    landUseType: determineLandUseType(item.fileNumber)
                });
            }
        }
    });
    
    return staffReportItems;
}

/**
 * Determine the type of land use case based on file number
 * @param {string} fileNumber - The file number (e.g., "REZ-25-40", "TA/CPA")
 * @returns {string} - The land use type
 */
function determineLandUseType(fileNumber) {
    if (fileNumber.startsWith('REZ-')) return 'REZONING';
    if (fileNumber.startsWith('TA/CPA')) return 'TEXT_AMENDMENT_COMP_PLAN';
    if (fileNumber.startsWith('VAC-')) return 'VACATION';
    if (fileNumber.startsWith('SU-')) return 'SPECIAL_USE';
    return 'OTHER';
}

/**
 * Structure for the data we want to extract from staff reports
 */
const STAFF_REPORT_FIELDS = {
    CURRENT_ZONING: ['CURRENT ZONING', 'EXISTING ZONING'],
    REQUESTED_ZONING: ['REQUESTED ZONING', 'PROPOSED ZONING'],
    FUTURE_LAND_USE: ['FUTURE LAND USE'],
    WAIVERS: [
        'WAIVERS',
        'WAIVER(S) REQUESTED', 
        'NEW WAIVER(S) REQUESTED',
        'PREVIOUSLY APPROVED WAIVERS'
    ],
    FINDINGS: ['FINDINGS', 'STAFF FINDINGS']
};

/**
 * Test the staff report identification with meeting 2616
 */
function testStaffReportIdentification() {
    try {
        const meetingData = JSON.parse(
            fs.readFileSync('./data/meeting_2616_2025-08-21.json', 'utf8')
        );
        
        console.log(`\n📊 Meeting ${meetingData.meetingId} - ${meetingData.meetingDate}`);
        console.log(`Meeting Type: ${meetingData.meetingType}\n`);
        
        const staffReportItems = identifyStaffReports(meetingData);
        
        console.log(`Found ${staffReportItems.length} agenda items with staff reports:\n`);
        
        staffReportItems.forEach((item, index) => {
            console.log(`${index + 1}. ${item.fileNumber} (${item.landUseType})`);
            console.log(`   Agenda Item ID: ${item.agendaItemId}`);
            console.log(`   Staff Reports Found: ${item.staffReports.length}`);
            
            item.staffReports.forEach((report, reportIndex) => {
                console.log(`   ${reportIndex + 1}. ${report.title}`);
                console.log(`      URL: ${report.url}`);
            });
            console.log('');
        });
        
        return staffReportItems;
        
    } catch (error) {
        console.error('Error testing staff report identification:', error.message);
        return [];
    }
}

/**
 * Download and parse a staff report PDF (placeholder for future implementation)
 * @param {object} staffReportItem - Item with staff report documents
 * @returns {Promise<object>} - Parsed staff report data
 */
async function parseStaffReport(staffReportItem) {
    // Placeholder for PDF parsing logic
    console.log(`🔍 Would parse staff report for ${staffReportItem.fileNumber}`);
    
    // Return structure for parsed data
    return {
        fileNumber: staffReportItem.fileNumber,
        agendaItemId: staffReportItem.agendaItemId,
        landUseType: staffReportItem.landUseType,
        extractedData: {
            currentZoning: null,
            requestedZoning: null,
            waivers: [],
            findings: null
        },
        parseStatus: 'PENDING_IMPLEMENTATION'
    };
}

/**
 * Download and extract text from a staff report PDF using existing infrastructure
 * @param {string} pdfUrl - The URL to download from  
 * @param {object} driver - Selenium WebDriver instance (optional, for session cookies)
 * @returns {Promise<string>} - Extracted text content
 */
async function downloadAndExtractStaffReportPDF(pdfUrl, driver = null) {
    try {
        // Ensure we have a full URL
        const fullPdfUrl = pdfUrl.startsWith('http') 
            ? pdfUrl 
            : 'https://tampagov.hylandcloud.com' + pdfUrl.replace(/&amp;/g, '&');
        
        let headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        };
        
        // If we have a driver, use session cookies
        if (driver) {
            try {
                const cookies = await driver.manage().getCookies();
                const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                headers.Cookie = cookieString;
                headers.Referer = await driver.getCurrentUrl();
                headers['User-Agent'] = await driver.executeScript('return navigator.userAgent');
            } catch (e) {
                console.log('⚠️  Could not get browser cookies, proceeding without...');
            }
        }
        
        // Download the PDF
        const response = await axios.get(fullPdfUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: headers
        });
        
        // Check if this is actually a PDF
        const pdfHeader = Buffer.from(response.data.slice(0, 10)).toString('ascii');
        if (!pdfHeader.startsWith('%PDF')) {
            throw new Error('Downloaded file is not a valid PDF');
        }
        
        // Suppress pdf-parse warnings (TT font warnings) by temporarily redirecting stderr
        const originalStderrWrite = process.stderr.write;
        process.stderr.write = () => {};

        // Parse the PDF using the existing infrastructure
        const pdfData = await pdfParse(response.data);

        // Restore stderr
        process.stderr.write = originalStderrWrite;

        return pdfData.text;
        
    } catch (error) {
        console.error(`Error downloading/parsing PDF: ${error.message}`);
        return null;
    }
}

/**
 * Parse staff report content to extract zoning information
 * @param {string} textContent - Raw text content from PDF
 * @param {string} fileNumber - File number for context
 * @returns {object} - Parsed zoning data
 */
function parseZoningData(textContent, fileNumber) {
    const extractedData = {
        currentZoning: null,
        requestedZoning: null,
        futureLandUse: null,
        waivers: [],
        findings: null
    };
    
    if (!textContent) return extractedData;
    
    console.log(`📖 Parsing zoning data for ${fileNumber}...`);
    
    // Clean up text and split into lines
    const lines = textContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    // Find the zoning section (looks for the two-column format)
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Look for the zoning header line that contains both current and requested
        if (line.includes('CURRENT ZONING:') && line.includes('REQUESTED ZONING:')) {
            // Next line should contain the actual zoning designations
            if (i + 1 < lines.length) {
                const zoningLine = lines[i + 1];
                console.log(`   Found zoning line: ${zoningLine}`);
                
                // For the format: "PD (Planned Development) (REZ-22-72; Ord. 2022-191) PD (Planned Development)"
                // Split by ')' and look for zoning codes at the start of segments
                const segments = zoningLine.split(/\)\s+/);
                
                if (segments.length >= 2) {
                    // Current zoning is typically the first segment
                    const currentMatch = segments[0].match(/^([A-Z]{1,4}(?:-\d+)?)/);
                    if (currentMatch) {
                        extractedData.currentZoning = currentMatch[1];
                        console.log(`   Current Zoning: ${extractedData.currentZoning}`);
                    }
                    
                    // Requested zoning - look in the last segment
                    const requestedMatch = segments[segments.length - 1].match(/^([A-Z]{1,4}(?:-\d+)?)/);
                    if (requestedMatch) {
                        extractedData.requestedZoning = requestedMatch[1];
                        console.log(`   Requested Zoning: ${extractedData.requestedZoning}`);
                    }
                }
            }
        }
        
        // Alternative: Look for separate CURRENT ZONING and REQUESTED ZONING lines
        if (line.startsWith('CURRENT ZONING:') && !line.includes('REQUESTED ZONING:')) {
            const zoningText = line.replace('CURRENT ZONING:', '').trim();
            const zoningMatch = zoningText.match(/^([A-Z]{1,4}(?:-\d+)?)/);
            if (zoningMatch) {
                extractedData.currentZoning = zoningMatch[1];
                console.log(`   Current Zoning: ${extractedData.currentZoning}`);
            }
        }
        
        if (line.startsWith('REQUESTED ZONING:')) {
            const zoningText = line.replace('REQUESTED ZONING:', '').trim();
            const zoningMatch = zoningText.match(/^([A-Z]{1,4}(?:-\d+)?)/);
            if (zoningMatch) {
                extractedData.requestedZoning = zoningMatch[1];
                console.log(`   Requested Zoning: ${extractedData.requestedZoning}`);
            }
        }
    }
    
    // Find Future Land Use
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('FUTURE LAND USE:')) {
            const futureLandUseMatch = line.match(/FUTURE LAND USE:\s*([^(]+)/);
            if (futureLandUseMatch) {
                extractedData.futureLandUse = futureLandUseMatch[1].trim();
                console.log(`   Future Land Use: ${extractedData.futureLandUse}`);
            }
        }
    }
    
    // Find waivers sections - need to handle multiple waiver sections
    let inWaiverSection = false;
    let currentWaiverText = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const upperLine = line.toUpperCase();
        
        // Start of waiver sections
        if (upperLine.includes('PREVIOUSLY APPROVED WAIVERS') || 
            upperLine.includes('NEW WAIVER') || 
            upperLine.includes('WAIVER(S) REQUESTED')) {
            
            // Save previous waiver if exists
            if (currentWaiverText.trim()) {
                extractedData.waivers.push(currentWaiverText.trim());
                console.log(`   Waiver: ${currentWaiverText.trim().substring(0, 80)}...`);
            }
            
            inWaiverSection = true;
            currentWaiverText = line;
            continue;
        }
        
        // End waiver section when we hit FINDINGS
        if (upperLine.includes('FINDINGS:')) {
            // Save current waiver
            if (currentWaiverText.trim()) {
                extractedData.waivers.push(currentWaiverText.trim());
                console.log(`   Waiver: ${currentWaiverText.trim().substring(0, 80)}...`);
            }
            inWaiverSection = false;
            
            // Start collecting findings
            let findingsText = line + ' ';
            for (let j = i + 1; j < lines.length; j++) {
                const nextLine = lines[j].toUpperCase();
                if (lines[j].trim() && 
                    !nextLine.includes('RECOMMENDATION') &&
                    !nextLine.includes('PREPARED BY') &&
                    !nextLine.includes('CONTACT') &&
                    !nextLine.includes('DEVELOPMENT COORDINATION')) {
                    findingsText += lines[j] + ' ';
                } else {
                    break;
                }
                // Limit findings length
                if (j > i + 15) break;
            }
            
            // Clean up common PDF artifacts from findings text
            let cleanFindings = findingsText.trim();
            cleanFindings = cleanFindings.replace(/\s*LOCATION MAP:\s*REZONING STAFF REPORT\s*REZ-\d{2}-\s*\d+\s*$/i, '');
            cleanFindings = cleanFindings.replace(/\s*REZONING STAFF REPORT\s*REZ-\d{2}-\s*\d+\s*$/i, '');
            
            extractedData.findings = cleanFindings;
            console.log(`   Findings: ${cleanFindings.substring(0, 100)}...`);
            break;
        }
        
        // Continue collecting waiver text
        if (inWaiverSection) {
            currentWaiverText += ' ' + line;
        }
    }
    
    // Clean up any remaining waiver text
    if (currentWaiverText.trim() && !extractedData.findings) {
        extractedData.waivers.push(currentWaiverText.trim());
        console.log(`   Waiver: ${currentWaiverText.trim().substring(0, 80)}...`);
    }
    
    return extractedData;
}

/**
 * Process a single staff report item (download and parse)
 * @param {object} staffReportItem - Item with staff report documents
 * @param {object} driver - Selenium WebDriver instance (optional)
 * @returns {Promise<object>} - Parsed staff report data
 */
async function processStaffReport(staffReportItem, driver = null) {
    try {
        const results = [];
        
        for (const report of staffReportItem.staffReports) {
            console.log(`📥 Processing ${report.title} for ${staffReportItem.fileNumber}...`);
            
            try {
                // Download and extract text using existing infrastructure
                const textContent = await downloadAndExtractStaffReportPDF(report.url, driver);
                
                if (!textContent) {
                    throw new Error('Could not extract text from PDF');
                }
                
                // Parse zoning data
                const extractedData = parseZoningData(textContent, staffReportItem.fileNumber);
                
                const result = {
                    fileNumber: staffReportItem.fileNumber,
                    agendaItemId: staffReportItem.agendaItemId,
                    landUseType: staffReportItem.landUseType,
                    reportTitle: report.title,
                    reportUrl: report.url,
                    extractedData: extractedData
                };
                
                results.push(result);
                
            } catch (error) {
                console.error(`❌ Error processing ${report.title}: ${error.message}`);
                results.push({
                    fileNumber: staffReportItem.fileNumber,
                    agendaItemId: staffReportItem.agendaItemId,
                    landUseType: staffReportItem.landUseType,
                    reportTitle: report.title,
                    reportUrl: report.url,
                    extractedData: null,
                    error: error.message
                });
            }
        }
        
        return results.length === 1 ? results[0] : results;
        
    } catch (error) {
        console.error(`❌ Error in processStaffReport: ${error.message}`);
        return {
            fileNumber: staffReportItem.fileNumber,
            error: error.message
        };
    }
}

/**
 * Save parsing results to JSON file for analysis
 * @param {object} results - Parsing results to save
 * @param {string} outputPath - Path to save the results
 */
function saveParsingResults(results, outputPath = './output/staff-report-parsing-results.json') {
    try {
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        // Add timestamp to results
        const resultsWithMetadata = {
            timestamp: new Date().toISOString(),
            meetingId: results.meetingId || 'unknown',
            totalItemsParsed: Array.isArray(results.items) ? results.items.length : 1,
            results: results
        };
        
        fs.writeFileSync(outputPath, JSON.stringify(resultsWithMetadata, null, 2));
        console.log(`💾 Results saved to: ${outputPath}`);
        
    } catch (error) {
        console.error(`Error saving results: ${error.message}`);
    }
}

/**
 * Process staff reports and integrate data directly into agenda items
 * @param {object} meetingData - The complete meeting data with agenda items
 * @returns {Promise<object>} - Modified meeting data with staff report data integrated
 */
async function integrateStaffReportsIntoAgendaItems(meetingData) {
    const staffReportItems = identifyStaffReports(meetingData);
    
    console.log(`\n🏛️  Processing ${staffReportItems.length} staff reports for meeting ${meetingData.meetingId}...`);
    
    for (const staffReportItem of staffReportItems) {
        console.log(`Processing ${staffReportItem.fileNumber}...`);
        
        try {
            const result = await processStaffReport(staffReportItem);
            
            // Find the corresponding agenda item and add staff report data
            const agendaItem = meetingData.agendaItems.find(item => 
                item.agendaItemId === staffReportItem.agendaItemId
            );
            
            if (agendaItem && result.extractedData) {
                agendaItem.staffReport = {
                    landUseType: staffReportItem.landUseType,
                    currentZoning: result.extractedData.currentZoning,
                    requestedZoning: result.extractedData.requestedZoning,
                    futureLandUse: result.extractedData.futureLandUse,
                    waivers: result.extractedData.waivers,
                    findings: result.extractedData.findings
                };
                console.log(`✅ Added staff report data to ${staffReportItem.fileNumber}`);
            }
            
            // Add a small delay to avoid overwhelming the server
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`❌ Error processing ${staffReportItem.fileNumber}: ${error.message}`);
            
            // Add error info to agenda item
            const agendaItem = meetingData.agendaItems.find(item => 
                item.agendaItemId === staffReportItem.agendaItemId
            );
            if (agendaItem) {
                agendaItem.staffReportError = error.message;
            }
        }
    }
    
    return meetingData;
}

/**
 * Process all staff reports for a meeting (for integration with json-scraper.js)
 * @param {object} meetingData - The complete meeting data
 * @returns {Promise<Array>} - Array of parsed staff report results
 */
async function processAllStaffReports(meetingData) {
    const staffReportItems = identifyStaffReports(meetingData);
    const results = [];
    
    console.log(`\n📋 Processing ${staffReportItems.length} staff reports for meeting ${meetingData.meetingId}...\n`);
    
    for (const item of staffReportItems) {
        console.log(`Processing ${item.fileNumber}...`);
        try {
            const result = await processStaffReport(item);
            results.push(result);
            
            // Add a small delay to avoid overwhelming the server
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`Error processing ${item.fileNumber}: ${error.message}`);
            results.push({
                fileNumber: item.fileNumber,
                parseStatus: 'FAILED',
                error: error.message
            });
        }
    }
    
    return results;
}

/**
 * Test parsing with a single staff report (REZ-25-40 as example)
 */
async function testSingleStaffReportParsing() {
    try {
        const meetingData = JSON.parse(
            fs.readFileSync('./data/meeting_2616_2025-08-21.json', 'utf8')
        );
        
        const staffReportItems = identifyStaffReports(meetingData);
        
        if (staffReportItems.length === 0) {
            console.log('No staff reports found to test');
            return;
        }
        
        // Test with the first staff report (REZ-25-40)
        const testItem = staffReportItems[0];
        console.log(`\n🧪 Testing PDF parsing with ${testItem.fileNumber}...\n`);
        
        const result = await processStaffReport(testItem);
        
        console.log('\n📊 Parsing Results:');
        console.log('='.repeat(50));
        console.log(`File Number: ${result.fileNumber}`);
        console.log(`Parse Status: ${result.parseStatus}`);
        console.log(`Text Length: ${result.textLength || 'N/A'} characters`);
        
        if (result.extractedData) {
            console.log(`Current Zoning: ${result.extractedData.currentZoning || 'Not found'}`);
            console.log(`Requested Zoning: ${result.extractedData.requestedZoning || 'Not found'}`);
            console.log(`Future Land Use: ${result.extractedData.futureLandUse || 'Not found'}`);
            console.log(`Waivers Found: ${result.extractedData.waivers.length}`);
            if (result.extractedData.waivers.length > 0) {
                result.extractedData.waivers.forEach((waiver, idx) => {
                    console.log(`  ${idx + 1}. ${waiver.substring(0, 100)}...`);
                });
            }
            console.log(`Findings: ${result.extractedData.findings ? 'Found (' + result.extractedData.findings.length + ' chars)' : 'Not found'}`);
            if (result.extractedData.findings) {
                console.log(`  Preview: ${result.extractedData.findings.substring(0, 200)}...`);
            }
        }
        
        if (result.error) {
            console.log(`Error: ${result.error}`);
        }
        
        // Save detailed results to file
        const detailedResults = {
            meetingId: meetingData.meetingId,
            meetingDate: meetingData.meetingDate,
            testItem: {
                fileNumber: result.fileNumber,
                agendaItemId: result.agendaItemId,
                landUseType: result.landUseType,
                parseStatus: result.parseStatus,
                extractedData: result.extractedData,
                reportTitle: result.reportTitle,
                textLength: result.textLength
            }
        };
        
        saveParsingResults(detailedResults, `./output/staff-report-test-${result.fileNumber}.json`);
        
        return result;
        
    } catch (error) {
        console.error('Error in test:', error.message);
    }
}

// Export functions for use in other modules
module.exports = {
    identifyStaffReports,
    selectMostRecentStaffReport,
    determineLandUseType,
    STAFF_REPORT_FIELDS,
    processStaffReport,
    processAllStaffReports,
    integrateStaffReportsIntoAgendaItems,
    downloadAndExtractStaffReportPDF,
    parseZoningData,
    saveParsingResults
};

// Run test if called directly
if (require.main === module) {
    console.log('🏛️  Tampa City Council Staff Report Analyzer\n');
    
    const args = process.argv.slice(2);
    
    if (args.includes('--test-pdf') || args.includes('-p')) {
        console.log('Running PDF parsing test...\n');
        testSingleStaffReportParsing();
    } else if (args.includes('--all') || args.includes('-a')) {
        console.log('Processing all staff reports...\n');
        (async () => {
            const meetingData = JSON.parse(fs.readFileSync('./data/meeting_2616_2025-08-21.json', 'utf8'));
            const results = await processAllStaffReports(meetingData);
            saveParsingResults({ 
                meetingId: meetingData.meetingId, 
                meetingDate: meetingData.meetingDate,
                items: results 
            }, './output/all-staff-reports-2616.json');
        })();
    } else {
        testStaffReportIdentification();
        console.log('\n💡 To test PDF parsing, run: node staff-report-parser.js --test-pdf');
        console.log('💡 To process all staff reports, run: node staff-report-parser.js --all');
    }
}

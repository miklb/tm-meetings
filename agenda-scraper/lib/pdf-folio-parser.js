const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const axios = require('axios');
require('dotenv').config();

// Mapbox Geocoding API token from environment variable
const MAPBOX_TOKEN = process.env.MAPBOX_API_TOKEN;

/**
 * Geocode an address using Mapbox Geocoding API
 * @param {string} address - Address to geocode
 * @param {string} context - Optional context like neighborhood/area name
 * @returns {Promise<{lat: number, lng: number}|null>} - Coordinates or null
 */
async function geocodeAddress(address, context = '') {
    if (!address) return null;
    
    // Build search query with context if provided
    let searchQuery = address;
    if (context) {
        searchQuery = `${address}, ${context}, Tampa, FL`;
    } else {
        searchQuery = `${address}, Tampa, FL`;
    }
    
    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(searchQuery)}.json`;
        
        const response = await axios.get(url, {
            params: {
                access_token: MAPBOX_TOKEN,
                limit: 1,
                proximity: '-82.4572,27.9506', // Tampa city center
                bbox: '-82.64,27.83,-82.24,28.11' // Tampa bounding box
            },
            timeout: 5000
        });

        if (response.data.features && response.data.features.length > 0) {
            const [lng, lat] = response.data.features[0].center;
            console.log(`[Geocoder] "${searchQuery}" -> ${lat}, ${lng}`);
            return { lat, lng };
        }

        console.log(`[Geocoder] No results for "${searchQuery}"`);
        return null;

    } catch (error) {
        console.error(`[Geocoder] Error geocoding "${searchQuery}":`, error.message);
        return null;
    }
}

/**
 * Parse TA/CPA TCC PACKET PDF to extract location, folio numbers, and geocode
 * @param {string} pdfUrl - URL to the PDF document
 * @param {string} fileNumber - File number for logging (e.g., "TA/CPA25-03")
 * @returns {Promise<{address: string, coordinates: {lat: number, lng: number}|null, folioNumbers: string[]}>}
 */
async function extractFolioNumbers(pdfUrl, fileNumber = 'Unknown') {
    const result = {
        address: '',
        coordinates: null,
        folioNumbers: []
    };

    try {
        console.log(`[PDF Parser] Downloading ${fileNumber} TCC PACKET...`);
        
        // Download PDF
        const response = await axios.get(pdfUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        const dataBuffer = Buffer.from(response.data);
        console.log(`[PDF Parser] Downloaded ${dataBuffer.length} bytes, parsing...`);

        // Note: You may see "Warning: TT:" messages from the PDF library.
        // These are harmless font rendering warnings from the native PDF parser (poppler/cairo)
        // and can be safely ignored. To suppress them, run with: 2>/dev/null
        
        // Parse PDF
        const pdfData = await pdfParse(dataBuffer, {
            max: 50 // Only parse first 50 pages to improve performance
        });

        const text = pdfData.text;
        console.log(`[PDF Parser] Extracted ${text.length} characters of text`);

        // Find the "Plan Amendment Request" or "Request for Plan Amendment" section with Location and Folio Numbers
        const planAmendmentMatch = text.match(/(?:Plan Amendment Request|Request for Plan Amendment)[\s\S]{0,3000}?Location:\s*([^\n]+)[\s\S]{0,1000}?Folio Numbers?:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
        
        if (!planAmendmentMatch) {
            console.log(`[PDF Parser] Could not find "Plan Amendment Request" or "Request for Plan Amendment" section in ${fileNumber}`);
            return result;
        }

        // Extract neighborhood/area context from the PDF text (common Tampa neighborhoods)
        const neighborhoods = [
            'Davis Islands', 'Ybor City', 'Hyde Park', 'Seminole Heights',
            'Palma Ceia', 'Westshore', 'Channelside', 'Harbour Island',
            'Bayshore', 'South Tampa', 'West Tampa', 'East Tampa',
            'Downtown', 'Carrollwood', 'Town \'N\' Country', 'Temple Terrace'
        ];
        
        let neighborhoodContext = '';
        for (const neighborhood of neighborhoods) {
            // Look in first 2000 characters for neighborhood mention
            const searchText = text.substring(0, 2000);
            if (new RegExp(neighborhood, 'i').test(searchText)) {
                neighborhoodContext = neighborhood;
                console.log(`[PDF Parser] Found neighborhood context: "${neighborhoodContext}"`);
                break;
            }
        }

        // Extract location (first address)
        const locationText = planAmendmentMatch[1].trim();
        // Split by common delimiters and take first address
        const addresses = locationText.split(/[,;]/).map(a => a.trim()).filter(a => a.length > 0);
        if (addresses.length > 0) {
            // If the first address contains "and" with multiple street numbers, take just the first number
            let firstAddress = addresses[0];
            const multipleAddressMatch = firstAddress.match(/^(\d+)\s+(?:and\s+\d+\s+)?(.+)$/i);
            if (multipleAddressMatch) {
                // Extract just the first address number with the street name
                firstAddress = `${multipleAddressMatch[1]} ${multipleAddressMatch[2]}`;
                console.log(`[PDF Parser] Normalized multiple addresses to single: "${firstAddress}"`);
            }
            result.address = firstAddress;
            console.log(`[PDF Parser] Found location: "${result.address}"`);
            
            // Geocode the address with neighborhood context if available
            result.coordinates = await geocodeAddress(result.address, neighborhoodContext);
        }

        // Extract folio numbers
        const folioSection = planAmendmentMatch[2];
        console.log(`[PDF Parser] Found folio section: "${folioSection.substring(0, 200)}..."`);

        // Pattern matches: digits followed by optional decimal and more digits
        const folioPattern = /\b(\d{5,8}(?:\.\d{4})?)\b/g;
        const matches = folioSection.match(folioPattern);

        if (matches) {
            // Clean and deduplicate folio numbers
            result.folioNumbers = [...new Set(matches)]
                .filter(folio => {
                    // Filter out numbers that are too short or look like dates/years
                    const num = parseFloat(folio);
                    return num >= 10000 && num < 100000000; // Reasonable folio range
                })
                .sort();

            console.log(`[PDF Parser] Extracted ${result.folioNumbers.length} folio numbers from ${fileNumber}`);
        } else {
            console.log(`[PDF Parser] No folio numbers found in section for ${fileNumber}`);
        }

        return result;

    } catch (error) {
        console.error(`[PDF Parser] Error extracting data from ${fileNumber}:`, error.message);
        return result;
    }
}

/**
 * Parse local PDF file to extract location and folio numbers (for testing)
 * @param {string} filePath - Path to local PDF file
 * @returns {Promise<{address: string, coordinates: {lat: number, lng: number}|null, folioNumbers: string[]}>}
 */
async function extractFolioNumbersFromFile(filePath) {
    const result = {
        address: '',
        coordinates: null,
        folioNumbers: []
    };

    try {
        console.log(`[PDF Parser] Reading local file: ${filePath}`);
        const dataBuffer = fs.readFileSync(filePath);
        
        // Note: You may see "Warning: TT:" messages from the PDF library.
        // These are harmless font rendering warnings from the native PDF parser (poppler/cairo)
        // and can be safely ignored. To suppress them, run with: 2>/dev/null

        const pdfData = await pdfParse(dataBuffer, {
            max: 50
        });

        const text = pdfData.text;
        console.log(`[PDF Parser] Extracted ${text.length} characters of text`);

        const planAmendmentMatch = text.match(/(?:Plan Amendment Request|Request for Plan Amendment)[\s\S]{0,3000}?Location:\s*([^\n]+)[\s\S]{0,1000}?Folio Numbers?:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
        
        if (!planAmendmentMatch) {
            console.log(`[PDF Parser] Could not find "Plan Amendment Request" or "Request for Plan Amendment" section`);
            return result;
        }

        // Extract neighborhood/area context from the PDF text (common Tampa neighborhoods)
        const neighborhoods = [
            'Davis Islands', 'Ybor City', 'Hyde Park', 'Seminole Heights',
            'Palma Ceia', 'Westshore', 'Channelside', 'Harbour Island',
            'Bayshore', 'South Tampa', 'West Tampa', 'East Tampa',
            'Downtown', 'Carrollwood', 'Town \'N\' Country', 'Temple Terrace'
        ];
        
        let neighborhoodContext = '';
        for (const neighborhood of neighborhoods) {
            // Look in first 2000 characters for neighborhood mention
            const searchText = text.substring(0, 2000);
            if (new RegExp(neighborhood, 'i').test(searchText)) {
                neighborhoodContext = neighborhood;
                console.log(`[PDF Parser] Found neighborhood context: "${neighborhoodContext}"`);
                break;
            }
        }

        // Extract location
        const locationText = planAmendmentMatch[1].trim();
        const addresses = locationText.split(/[,;]/).map(a => a.trim()).filter(a => a.length > 0);
        if (addresses.length > 0) {
            // If the first address contains "and" with multiple street numbers, take just the first number
            let firstAddress = addresses[0];
            const multipleAddressMatch = firstAddress.match(/^(\d+)\s+(?:and\s+\d+\s+)?(.+)$/i);
            if (multipleAddressMatch) {
                // Extract just the first address number with the street name
                firstAddress = `${multipleAddressMatch[1]} ${multipleAddressMatch[2]}`;
                console.log(`[PDF Parser] Normalized multiple addresses to single: "${firstAddress}"`);
            }
            result.address = firstAddress;
            console.log(`[PDF Parser] Found location: "${result.address}"`);
            result.coordinates = await geocodeAddress(result.address, neighborhoodContext);
        }

        // Extract folio numbers
        const folioSection = planAmendmentMatch[2];
        const folioPattern = /\b(\d{5,8}(?:\.\d{4})?)\b/g;
        const matches = folioSection.match(folioPattern);

        if (matches) {
            result.folioNumbers = [...new Set(matches)]
                .filter(folio => {
                    const num = parseFloat(folio);
                    return num >= 10000 && num < 100000000;
                })
                .sort();

            console.log(`[PDF Parser] Extracted ${result.folioNumbers.length} folio numbers`);
        }

        return result;

    } catch (error) {
        console.error(`[PDF Parser] Error:`, error.message);
        return result;
    }
}

/**
 * Find TCC PACKET PDF URL in supporting documents
 * @param {Array} supportingDocuments - Array of document objects
 * @returns {string|null} - URL of TCC PACKET PDF or null if not found
 */
function findTccPacketUrl(supportingDocuments) {
    if (!supportingDocuments || !Array.isArray(supportingDocuments)) {
        return null;
    }

    // Look for "TCC PACKET" or "TCC STAFF REPORT" in the title
    const tccPacket = supportingDocuments.find(doc => 
        doc.title && /TCC\s+(?:PACKET|STAFF\s+REPORT)/i.test(doc.title)
    );

    return tccPacket ? tccPacket.url : null;
}

module.exports = {
    extractFolioNumbers,
    extractFolioNumbersFromFile,
    findTccPacketUrl,
    geocodeAddress
};

// Run from agenda-scraper dir where node_modules exists
const axios = require('axios');
const pdfParse = require('pdf-parse');

async function main() {
    const url = 'https://docs.meetings.tampamonitor.com/2026-04-23/meeting-2841/23445/ta-cpa-25-18-tcc-packet.pdf';
    console.log('Downloading TCC PACKET for TA/CPA25-18...');
    
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000
    });
    
    const dataBuffer = Buffer.from(response.data);
    console.log(`Downloaded ${dataBuffer.length} bytes`);
    
    const pdfData = await pdfParse(dataBuffer, { max: 10 });
    const text = pdfData.text;
    
    // Show first 3000 chars
    console.log('\n=== FIRST 3000 CHARS ===');
    console.log(text.substring(0, 3000));
    
    // Find "Plan Amendment Request" section
    const planMatch = text.match(/(?:Plan Amendment Request|Request for Plan Amendment)[\s\S]{0,3000}?Location:\s*([^\n]+)[\s\S]{0,1000}?Folio Numbers?:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
    
    if (planMatch) {
        console.log('\n=== REGEX MATCH ===');
        console.log('Location:', planMatch[1].trim());
        console.log('Folio section:', planMatch[2].trim().substring(0, 200));
    } else {
        console.log('\n=== NO REGEX MATCH ===');
        const locationIdx = text.indexOf('Location:');
        const folioIdx = text.indexOf('Folio');
        const planIdx = text.indexOf('Plan Amendment');
        const requestIdx = text.indexOf('Request for Plan');
        console.log('Plan Amendment at:', planIdx);
        console.log('Request for Plan at:', requestIdx);
        console.log('Location: at:', locationIdx);
        console.log('Folio at:', folioIdx);
        
        if (locationIdx > 0) {
            console.log('\nAround Location:');
            console.log(text.substring(locationIdx - 50, locationIdx + 200));
        }
        if (folioIdx > 0) {
            console.log('\nAround Folio:');
            console.log(text.substring(folioIdx - 50, folioIdx + 200));
        }
    }
    
    // Search for 125293
    const folioRef = text.indexOf('125293');
    if (folioRef >= 0) {
        console.log('\n=== FOLIO 125293 CONTEXT ===');
        console.log(text.substring(Math.max(0, folioRef - 200), folioRef + 200));
    } else {
        console.log('\n=== FOLIO 125293 NOT FOUND IN PDF ===');
    }
    
    // Search for CBD
    const cbdRef = text.indexOf('CBD');
    if (cbdRef >= 0) {
        console.log('\n=== CBD REFERENCE ===');
        console.log(text.substring(Math.max(0, cbdRef - 200), cbdRef + 200));
    }
    
    // Search for Euclid
    const euclidRef = text.indexOf('Euclid');
    if (euclidRef >= 0) {
        console.log('\n=== EUCLID REFERENCE ===');
        console.log(text.substring(Math.max(0, euclidRef - 200), euclidRef + 200));
    }
    
    // Search for R-20 (expected zoning)
    const r20Ref = text.indexOf('R-20');
    if (r20Ref >= 0) {
        console.log('\n=== R-20 REFERENCE ===');
        console.log(text.substring(Math.max(0, r20Ref - 200), r20Ref + 200));
    }
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * Analyze document sizes from meeting JSON files
 * Downloads to local cache to calculate storage costs without uploading to S3
 * 
 * Usage:
 *   node analyze-documents.js data/meeting_2650_2025-12-11.json
 *   node analyze-documents.js data/meeting_*.json --cache
 *   node analyze-documents.js --recent 7  # Last 7 days
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '.document-cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Get cache path for a URL
 */
function getCachePath(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return path.join(CACHE_DIR, hash);
}

/**
 * Check if document is cached
 */
function isCached(url) {
  return fs.existsSync(getCachePath(url));
}

/**
 * Get cached size or download and cache
 * Always does a full GET since OnBase doesn't support HEAD properly
 */
async function getDocumentSize(url, title, useCache = true) {
  const cachePath = getCachePath(url);
  const metaPath = cachePath + '.meta';
  
  // Check cache first
  if (useCache && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return { size: meta.size, cached: true, contentType: meta.contentType };
  }
  
  try {
    // Full GET request - OnBase doesn't support HEAD properly
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 100 * 1024 * 1024,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/pdf,*/*',
      },
    });
    
    const size = response.data.length;
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    
    // Check if we got an actual PDF or an error page
    const isPdf = contentType.includes('pdf') || 
                  (response.data[0] === 0x25 && response.data[1] === 0x50); // %P (PDF magic bytes)
    
    if (!isPdf && size < 10000) {
      // Probably an error page
      const text = Buffer.from(response.data).toString('utf8').substring(0, 200);
      if (text.includes('<!DOCTYPE') || text.includes('<html')) {
        return { size: 0, error: 'Received HTML instead of PDF (likely auth required)', cached: false };
      }
    }
    
    // Cache the file and metadata
    fs.writeFileSync(cachePath, response.data);
    fs.writeFileSync(metaPath, JSON.stringify({
      url,
      title,
      size,
      contentType,
      isPdf,
      checkedAt: new Date().toISOString(),
    }));
    
    return { size, cached: false, contentType, isPdf };
    
  } catch (err) {
    return { size: 0, error: err.message, cached: false };
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Analyze a single meeting JSON
 */
async function analyzeMeeting(jsonPath, options = {}) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const meetingId = data.meetingId;
  const meetingDate = data.formattedDate || data.meetingDate;
  const meetingType = data.meetingType || 'Unknown';
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Meeting ${meetingId}: ${meetingType} (${meetingDate})`);
  console.log('='.repeat(70));
  
  const results = {
    meetingId,
    meetingDate,
    meetingType,
    totalDocuments: 0,
    totalSize: 0,
    cachedCount: 0,
    errorCount: 0,
    documents: [],
    byType: {},
  };
  
  // Collect all documents
  const allDocs = [];
  for (const item of data.agendaItems || []) {
    if (item.supportingDocuments && item.supportingDocuments.length > 0) {
      for (const doc of item.supportingDocuments) {
        allDocs.push({
          itemNumber: item.number,
          fileNumber: item.fileNumber,
          ...doc,
        });
      }
    }
  }
  
  if (allDocs.length === 0) {
    console.log('  No documents found.');
    return results;
  }
  
  console.log(`  Analyzing ${allDocs.length} documents...\n`);
  
  // Process documents
  for (const doc of allDocs) {
    const title = doc.title || doc.originalText || 'unknown';
    process.stdout.write(`  [${results.totalDocuments + 1}/${allDocs.length}] ${title.substring(0, 50)}...`);
    
    const info = await getDocumentSize(doc.url, title, options.useCache !== false);
    
    results.totalDocuments++;
    
    if (info.error) {
      console.log(` ✗ ${info.error}`);
      results.errorCount++;
    } else {
      results.totalSize += info.size;
      if (info.cached) results.cachedCount++;
      
      const ext = path.extname(title).toLowerCase() || '.pdf';
      results.byType[ext] = (results.byType[ext] || 0) + info.size;
      
      console.log(` ${formatBytes(info.size)}${info.cached ? ' (cached)' : ''}`);
      
      results.documents.push({
        title,
        size: info.size,
        itemNumber: doc.itemNumber,
        fileNumber: doc.fileNumber,
      });
    }
  }
  
  return results;
}

/**
 * Print summary
 */
function printSummary(allResults) {
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  
  let grandTotal = 0;
  let totalDocs = 0;
  let totalErrors = 0;
  const byType = {};
  
  for (const result of allResults) {
    console.log(`\n  ${result.meetingType} (${result.meetingDate}): ${result.totalDocuments} docs, ${formatBytes(result.totalSize)}`);
    grandTotal += result.totalSize;
    totalDocs += result.totalDocuments;
    totalErrors += result.errorCount;
    
    for (const [ext, size] of Object.entries(result.byType)) {
      byType[ext] = (byType[ext] || 0) + size;
    }
  }
  
  console.log('\n' + '-'.repeat(70));
  console.log(`TOTAL: ${totalDocs} documents, ${formatBytes(grandTotal)}`);
  if (totalErrors > 0) {
    console.log(`  (${totalErrors} documents failed to fetch)`);
  }
  
  console.log('\nBy file type:');
  for (const [ext, size] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ext}: ${formatBytes(size)}`);
  }
  
  // Cost estimates
  console.log('\n' + '-'.repeat(70));
  console.log('COST ESTIMATES (based on this sample):');
  console.log('-'.repeat(70));
  
  const gbSize = grandTotal / (1024 * 1024 * 1024);
  const meetingsPerYear = 150; // Rough estimate
  const weeksAnalyzed = allResults.length > 0 ? 1 : 0;
  const projectedAnnualGB = (gbSize / Math.max(weeksAnalyzed, 1)) * 52;
  
  console.log(`\n  This sample: ${formatBytes(grandTotal)} (${gbSize.toFixed(4)} GB)`);
  console.log(`  Projected annual (52 weeks): ~${projectedAnnualGB.toFixed(2)} GB`);
  
  console.log('\n  Storage Costs (annual projection):');
  console.log(`    Cloudflare R2:    FREE (10GB free tier covers ${(10 / projectedAnnualGB).toFixed(1)} years)`);
  console.log(`    Backblaze B2:     $${(projectedAnnualGB * 0.005 * 12).toFixed(2)}/year`);
  console.log(`    AWS S3:           $${(projectedAnnualGB * 0.023 * 12).toFixed(2)}/year`);
  console.log(`    Vultr Standard:   $${18 * 12}/year (1TB minimum, overkill)`);
  
  console.log('\n  Note: Egress costs vary. Cloudflare R2 has zero egress fees.');
}

/**
 * Main
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node analyze-documents.js <meeting-file.json> [more files...]');
    console.log('  node analyze-documents.js data/meeting_*2025-12*.json');
    console.log('  node analyze-documents.js --no-cache data/meeting_2650_2025-12-11.json');
    console.log('\nOptions:');
    console.log('  --no-cache    Force re-fetch all document sizes');
    console.log('\nCache location: .document-cache/');
    process.exit(1);
  }
  
  const useCache = !args.includes('--no-cache');
  const files = args.filter(a => !a.startsWith('--'));
  
  if (files.length === 0) {
    console.error('No meeting JSON files specified.');
    process.exit(1);
  }
  
  console.log(`Analyzing ${files.length} meeting(s)...`);
  console.log(`Cache: ${useCache ? 'enabled' : 'disabled'}`);
  
  const allResults = [];
  
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      continue;
    }
    
    try {
      const result = await analyzeMeeting(file, { useCache });
      allResults.push(result);
    } catch (err) {
      console.error(`Error processing ${file}: ${err.message}`);
    }
  }
  
  if (allResults.length > 0) {
    printSummary(allResults);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

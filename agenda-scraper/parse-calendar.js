#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PdfReader } = require('pdfreader');
const https = require('https');

/**
 * Parse a meeting calendar PDF using pdfreader
 * @param {string} url - URL to the PDF file
 */
async function parsePDF(url) {
  try {
    // Extract meeting ID from URL
    const meetingIdMatch = url.match(/id=(\d+)/) || url.match(/meetingId=(\d+)/);
    const meetingId = meetingIdMatch ? meetingIdMatch[1] : 'unknown';
    
    console.log(`Downloading PDF for meeting ID: ${meetingId}`);
    
    // Download the PDF file
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      httpsAgent: new https.Agent({ rejectUnauthorized: false }) // In case of SSL issues
    });
    
    console.log(`PDF downloaded (${response.data.byteLength} bytes), extracting text...`);
    
    // Set up for text extraction
    const outputDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }
    
    const debugDir = path.join(process.cwd(), 'debug');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir);
    }
    
    // Process PDF and extract text by page and position
    const pdfBuffer = response.data;
    let textItems = [];
    let currentPage = 1;
    
    // Create a promise that resolves when all pages are processed
    const processPdf = new Promise((resolve, reject) => {
      new PdfReader().parseBuffer(pdfBuffer, (err, item) => {
        if (err) {
          reject(err);
          return;
        }
        
        // End of file
        if (!item) {
          resolve();
          return;
        }
        
        // New page
        if (item.page) {
          currentPage = item.page;
          return;
        }
        
        // Process text item
        if (item.text) {
          textItems.push({
            page: currentPage,
            x: item.x,
            y: item.y,
            text: item.text
          });
        }
      });
    });
    
    await processPdf;
    console.log(`Extracted ${textItems.length} text items from PDF`);
    
    // Process the raw text items into organized content
    let pages = {};
    textItems.forEach(item => {
      if (!pages[item.page]) {
        pages[item.page] = [];
      }
      pages[item.page].push(item);
    });
    
    // Sort items by y-position (top to bottom) and then by x-position (left to right)
    Object.keys(pages).forEach(page => {
      pages[page].sort((a, b) => {
        // Group items that are roughly on the same line (within 0.2 units)
        if (Math.abs(a.y - b.y) < 0.2) {
          return a.x - b.x;
        }
        return a.y - b.y;
      });
    });
    
    // Convert the sorted items to lines of text
    let lines = [];
    Object.keys(pages).forEach(page => {
      let currentY = null;
      let currentLine = [];
      
      pages[page].forEach(item => {
        // If this is a new line
        if (currentY === null || Math.abs(item.y - currentY) >= 0.2) {
          if (currentLine.length > 0) {
            lines.push(currentLine.join(' ').trim());
          }
          currentY = item.y;
          currentLine = [item.text];
        } else {
          // Same line, add to current items
          currentLine.push(item.text);
        }
      });
      
      // Add the last line if needed
      if (currentLine.length > 0) {
        lines.push(currentLine.join(' ').trim());
      }
      
      // Add a marker for page breaks
      lines.push('--- PAGE BREAK ---');
    });
    
    // Clean up page breaks for final output
    let cleanedText = lines.join('\n')
      .replace(/--- PAGE BREAK ---\n\s*--- PAGE BREAK ---/g, '\n--- PAGE BREAK ---')
      .replace(/^\s*--- PAGE BREAK ---\s*$/gm, '\n');
    
    // Save the raw parsed text for debugging
    fs.writeFileSync(path.join(debugDir, `meeting_${meetingId}_raw.txt`), cleanedText);
    
    // Clean and normalize the text
    cleanedText = normalizeText(cleanedText);
    
    // Format as markdown
    let markdownContent = formatCalendarAsMarkdown(cleanedText, meetingId);
    
    // Add source URL at the bottom
    markdownContent += `\n\n---\n*Source: [Original Calendar Document](${url})*`;
    
    // Apply enhanced whitespace cleaning
    markdownContent = cleanMarkdown(markdownContent);
    
    // Write to file
    const outputFile = path.join(outputDir, `meeting_${meetingId}.md`);
    fs.writeFileSync(outputFile, markdownContent);
    
    console.log(`Calendar content extracted to ${outputFile}`);
    return true;
  } catch (error) {
    console.error("Error parsing PDF:", error);
    return false;
  }
}

/**
 * Normalize and clean text to remove ALL Unicode characters and fix formatting
 */
function normalizeText(text) {
  // First replace common Unicode characters we want to specifically handle
  const cleaned = text
    // Replace Unicode dashes with standard hyphen
    .replace(/[\u2013\u2014\u2212\u2015\u2010\u2011–—]/g, '-')
    
    // Replace Unicode quotes with standard quotes
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036""]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035'']/g, "'")
    
    // Replace Unicode spaces and control characters
    .replace(/[\u00A0\u2000-\u200F\u2028-\u202F\u205F\u3000]/g, ' ')
    
    // Replace bullets
    .replace(/[\u2022\u2023\u2043\u204C\u204D\u2219\u25D8\u25E6\u2619\u2765\u2767•]/g, '*');
    
  // AGGRESSIVE approach: Replace any remaining non-ASCII characters
  // This will catch ANY Unicode character we may have missed above
  return cleaned.replace(/[^\x00-\x7F]/g, match => {
    // Default replacements for common categories
    if (match === '…') return '...';  // Ellipsis
    if (match === '©') return '(c)';  // Copyright
    if (match === '®') return '(R)';  // Registered
    if (match === '™') return '(TM)'; // Trademark
    
    // For any other non-ASCII character, use a simple ASCII replacement
    return '-'; // Default replacement is hyphen
  });
}

/**
 * Format the cleaned text as a markdown calendar with proper whitespace
 */
function formatCalendarAsMarkdown(text, meetingId) {
  // Start with the title
  let markdownContent = "# City Council Calendar\n\n";
  
  // Format month headers
  const monthPattern = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)(?:\s+(?:continued|cont\.))?\s*-\s*\d{4}/gi;
  
  // Split content by month headers
  const parts = text.split(monthPattern);
  const monthHeaders = text.match(monthPattern) || [];
  
  // Process each month section
  for (let i = 0; i < monthHeaders.length; i++) {
    const monthHeader = monthHeaders[i];
    const monthContent = i === 0 ? parts[i+1] : parts[i+1];
    
    if (monthContent) {
      // Add month header
      markdownContent += `## ${monthHeader}\n\n`;
      
      // Process the month content
      let formattedContent = monthContent
        .replace(/(\d+)\s+(CITY COUNCIL|COMMUNITY REDEVELOPMENT AGENCY|CRA)\s+(REGULAR|WORKSHOP|EVENING|SPECIAL CALL)\s+SESSION/gi, 
                '\n\n### $1 $2 $3 SESSION\n\n')
        .replace(/(\d+:\d+\s*(?:A\.M\.|P\.M\.))/gi, '**$1**')
        .replace(/(File No\.\s+[A-Z0-9-]+)/gi, '**$1**')
        .replace(/Workshops\s+\((\d+)\)/gi, '\n\n#### Workshops ($1)\n\n')
        .replace(/Staff Reports & Unfinished Business\s+\((\d+)\)/gi, '\n\n#### Staff Reports & Unfinished Business ($1)\n\n')
        .replace(/Written Staff Reports\s+\((\d+)\)/gi, '\n\n#### Written Staff Reports ($1)\n\n');
      
      // Clean up whitespace
      formattedContent = formattedContent
        .replace(/\n{3,}/g, '\n\n')           // Replace multiple blank lines with double line break
        .replace(/^\s+/gm, '')                // Remove leading whitespace on each line
        .replace(/\s+$/gm, '')                // Remove trailing whitespace on each line
        .replace(/\n +- /g, '\n- ')           // Fix bullet point indentation
        .replace(/\s{2,}/g, ' ')              // Replace multiple spaces with a single space
        .replace(/\n\s*\n\s*\n/g, '\n\n')     // Normalize multiple blank lines again
        .replace(/\n\s*####/g, '\n\n####')    // Ensure space before subheaders
        .replace(/\n\s*###/g, '\n\n###')      // Ensure space before headers
        .replace(/####\s*\n\s*/g, '#### ')    // Fix extra line breaks after headers
        .replace(/ {2,}([•*-])/g, ' $1');     // Fix indented list items
      
      markdownContent += formattedContent.trim() + "\n\n";
    }
  }
  
  // Final whitespace cleanup for the entire document
  return markdownContent
    .replace(/\n\n\n+/g, '\n\n')              // Final normalization of blank lines
    .replace(/\n\s+\n/g, '\n\n')              // Remove spaces on blank lines
    .replace(/  +/g, ' ')                      // Remove double spaces
    .trim();
}

/**
 * Enhanced whitespace cleaning for markdown content
 */
function cleanMarkdown(markdown) {
  return markdown
    // Fix duplicate month sections
    .replace(/## (JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER).*\n\n\w+\n\n## \1/gi, 
             '## $1')
    
    // Fix empty sections with just month name
    .replace(/\n\n\w+\n\n/g, '\n\n')
    
    // Normalize heading spacing
    .replace(/\n{2,}(#{2,})/g, '\n\n$1')
    .replace(/(#{2,}.*)\n{3,}/g, '$1\n\n')
    
    // Normalize bullet point spacing
    .replace(/\n{2,}- /g, '\n- ')
    .replace(/- (.*)\n{3,}/g, '- $1\n\n')
    
    // Fix extra whitespace in list items
    .replace(/- +/g, '- ')
    
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    
    // Fix spacing around session markers
    .replace(/(SESSION)\n{3,}/, '$1\n\n')
    
    // Fix empty sections
    .replace(/####.*\n\n####/g, '####')
    
    // Remove lines with just whitespace
    .replace(/^\s+$/gm, '')
    
    // Final spacing cleanup
    .replace(/\n\n\n+/g, '\n\n');
}

// Get command line arguments
const url = process.argv[2];

if (!url) {
  console.error('Please provide a PDF URL as an argument');
  console.log('Usage: node parse-pdf-reader.js <pdf-url>');
  process.exit(1);
}

// Execute the parser
parsePDF(url)
  .then(success => {
    if (success) {
      console.log('PDF parsing completed successfully');
    } else {
      console.error('PDF parsing failed');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('Error executing PDF parser:', err);
    process.exit(1);
  });
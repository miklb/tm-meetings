#!/usr/bin/env node
/**
 * Mirror Documents CLI
 * Downloads supporting documents from OnBase and uploads to S3-compatible storage
 * 
 * Usage:
 *   node mirror-documents.js <meetingId>           # Mirror single meeting
 *   node mirror-documents.js --date 2025-12-11    # Mirror all meetings for a date
 *   node mirror-documents.js --all                 # Mirror all meetings in data/
 *   node mirror-documents.js <meetingId> --force   # Force re-upload existing documents
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { DocumentMirror } = require('./lib/document-mirror');

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    meetingIds: [],
    date: null,
    all: false,
    force: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--all' || arg === '-a') {
      options.all = true;
    } else if (arg === '--date' || arg === '-d') {
      options.date = args[++i];
    } else if (/^\d+$/.test(arg)) {
      options.meetingIds.push(arg);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      options.date = arg;
    }
  }

  return options;
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Mirror Documents - Upload agenda documents to S3-compatible storage

Usage:
  node mirror-documents.js [options] [meetingId...]

Arguments:
  meetingId              One or more meeting IDs to mirror

Options:
  -h, --help             Show this help message
  -d, --date YYYY-MM-DD  Mirror all meetings for a specific date
  -a, --all              Mirror all meetings in data/ directory
  -f, --force            Force re-upload even if document exists
  -n, --dry-run          Show what would be done without uploading

Environment Variables (required):
  S3_ENDPOINT            S3-compatible endpoint URL
  S3_ACCESS_KEY_ID       Access key ID
  S3_SECRET_ACCESS_KEY   Secret access key
  S3_BUCKET              Bucket name (default: agenda-docs)
  S3_PUBLIC_URL          Public URL base for documents

Examples:
  node mirror-documents.js 2650
  node mirror-documents.js --date 2025-12-11
  node mirror-documents.js 2650 2651 --force
  node mirror-documents.js --all
`);
}

/**
 * Find JSON files for a given date
 */
function findFilesForDate(date) {
  const dataDir = path.join(__dirname, 'data');
  return fs.readdirSync(dataDir)
    .filter(f => f.endsWith('.json') && f.includes(date))
    .map(f => path.join(dataDir, f));
}

/**
 * Find JSON file for a meeting ID
 */
function findFileForMeeting(meetingId) {
  const dataDir = path.join(__dirname, 'data');
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith(`meeting_${meetingId}_`) && f.endsWith('.json'));
  
  if (files.length === 0) {
    return null;
  }
  return path.join(dataDir, files[0]);
}

/**
 * Find all JSON files in data/
 */
function findAllFiles() {
  const dataDir = path.join(__dirname, 'data');
  return fs.readdirSync(dataDir)
    .filter(f => f.startsWith('meeting_') && f.endsWith('.json'))
    .map(f => path.join(dataDir, f));
}

/**
 * Load meeting data from JSON file
 */
function loadMeetingData(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error loading ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Save updated meeting data with mirrored URLs
 */
function saveMeetingData(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Check if required environment variables are set
 */
function checkEnvVars() {
  const required = ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = required.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    missing.forEach(v => console.error(`  - ${v}`));
    console.error('\nAdd these to your .env file or set them in your environment.');
    process.exit(1);
  }
}

/**
 * Main function
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Collect files to process
  let filesToProcess = [];

  if (options.all) {
    filesToProcess = findAllFiles();
    console.log(`Found ${filesToProcess.length} meeting files to process`);
  } else if (options.date) {
    filesToProcess = findFilesForDate(options.date);
    console.log(`Found ${filesToProcess.length} meeting files for ${options.date}`);
  } else if (options.meetingIds.length > 0) {
    for (const meetingId of options.meetingIds) {
      const file = findFileForMeeting(meetingId);
      if (file) {
        filesToProcess.push(file);
      } else {
        console.error(`No JSON file found for meeting ${meetingId}`);
      }
    }
  } else {
    console.error('Please specify meeting IDs, a date, or use --all');
    console.error('Use --help for usage information');
    process.exit(1);
  }

  if (filesToProcess.length === 0) {
    console.error('No meeting files found to process');
    process.exit(1);
  }

  // Check environment variables (unless dry run)
  if (!options.dryRun) {
    checkEnvVars();
  }

  // Summary statistics
  const summary = {
    meetings: 0,
    totalDocuments: 0,
    uploaded: 0,
    skipped: 0,
    failed: 0,
  };

  // Create mirror instance
  let mirror = null;
  if (!options.dryRun) {
    try {
      mirror = new DocumentMirror();
    } catch (err) {
      console.error(`Failed to initialize document mirror: ${err.message}`);
      process.exit(1);
    }
  }

  // Process each meeting
  for (const filePath of filesToProcess) {
    const meetingData = loadMeetingData(filePath);
    if (!meetingData) {
      continue;
    }

    if (options.dryRun) {
      // Dry run - just count documents
      console.log(`\n[DRY RUN] Meeting ${meetingData.meetingId}`);
      let docCount = 0;
      for (const item of meetingData.agendaItems) {
        if (item.supportingDocuments) {
          docCount += item.supportingDocuments.length;
        }
      }
      console.log(`  Would mirror ${docCount} documents`);
      summary.totalDocuments += docCount;
      summary.meetings++;
      continue;
    }

    // Mirror the meeting documents
    const results = await mirror.mirrorMeeting(meetingData, {
      force: options.force,
    });

    // Update summary
    summary.meetings++;
    summary.totalDocuments += results.totalDocuments;
    summary.uploaded += results.uploaded;
    summary.skipped += results.skipped;
    summary.failed += results.failed;

    // Save updated JSON with mirrored URLs
    if (results.uploaded > 0 || results.skipped > 0) {
      saveMeetingData(filePath, meetingData);
      console.log(`\nSaved updated JSON: ${path.basename(filePath)}`);
    }
  }

  // Final summary
  console.log('\n' + '='.repeat(60));
  console.log('OVERALL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Meetings processed: ${summary.meetings}`);
  console.log(`Total documents: ${summary.totalDocuments}`);
  
  if (!options.dryRun) {
    console.log(`  Uploaded: ${summary.uploaded}`);
    console.log(`  Already existed: ${summary.skipped}`);
    console.log(`  Failed: ${summary.failed}`);
  }

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

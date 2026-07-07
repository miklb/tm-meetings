#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

async function main() {
  const apiUrl = process.env.NOTIFICATIONS_API_URL || 'https://meetings.tampamonitor.com/api/notify';
  const secret = process.env.WEBHOOK_SECRET;

  if (!secret) {
    console.error('Error: WEBHOOK_SECRET environment variable is not defined.');
    process.exit(1);
  }

  // Support --meeting-ids=2591,2592 CLI arg or MEETING_IDS env var
  const args = process.argv.slice(2);
  const meetingIdsArg = (args.find(a => a.startsWith('--meeting-ids=')) || '').split('=')[1] || '';
  const meetingIdsRaw = meetingIdsArg || process.env.MEETING_IDS || '';
  const meetingIds = meetingIdsRaw.split(',').map(id => id.trim()).filter(Boolean);

  if (meetingIds.length === 0) {
    console.error('Error: Specify meeting IDs via MEETING_IDS env var or --meeting-ids=<id1,id2> flag.');
    process.exit(1);
  }

  // Support --wp-url=<url> CLI arg or WORDPRESS_AGENDA_URL env var
  const wpUrlArg = (args.find(a => a.startsWith('--wp-url=')) || '').split('=')[1] || '';
  const wordpressUrl = wpUrlArg || process.env.WORDPRESS_AGENDA_URL || '';

  if (!wordpressUrl) {
    console.warn('Warning: No WordPress agenda URL provided (WORDPRESS_AGENDA_URL or --wp-url). Email links will fall back to the static site.');
  }

  console.log(`Meeting IDs: ${meetingIds.join(', ')}`);
  if (wordpressUrl) {
    console.log(`WordPress URL: ${wordpressUrl}`);
  }

  const dataDir = path.resolve(process.cwd(), 'agenda-scraper/data');

  if (!fs.existsSync(dataDir)) {
    console.error(`Error: Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(dataDir);
  const meetings = [];

  for (const id of meetingIds) {
    const matchingFiles = allFiles.filter(f => new RegExp(`^meeting_${id}_.*\\.json$`).test(f));

    if (matchingFiles.length === 0) {
      console.error(`Error: No meeting JSON file found for ID ${id} in ${dataDir}`);
      process.exit(1);
    }

    if (matchingFiles.length > 1) {
      console.warn(`Warning: Multiple files found for meeting ID ${id}; using ${matchingFiles[0]}`);
    }

    const filePath = path.join(dataDir, matchingFiles[0]);
    console.log(`Reading: ${matchingFiles[0]}`);

    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`Error reading/parsing ${filePath}: ${err.message}`);
      process.exit(1);
    }

    meetings.push({
      meetingId: data.meetingId,
      meetingType: data.meetingType || 'regular',
      meetingDate: data.meetingDate,
      wordpressUrl: wordpressUrl || null,
      agendaItems: (data.agendaItems || []).map(item => ({
        number: item.number,
        agendaItemId: item.agendaItemId,
        title: item.title,
        fileNumber: item.fileNumber,
        background: item.background || '',
        staffReport: item.staffReport || null,
        supportingDocuments: (item.supportingDocuments || []).map(doc => ({
          title: doc.title,
          url: doc.mirroredUrl || doc.url
        }))
      }))
    });
  }

  const payload = { meetings };
  console.log(`\nSending ${meetings.length} meeting(s) to ${apiUrl}...`);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': secret
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    console.log(`Response: ${response.status} ${response.statusText}`);
    console.log(responseText);

    if (!response.ok) {
      throw new Error(`Server returned error status: ${response.status}`);
    }

    console.log('\nNotifications dispatched successfully.');
  } catch (err) {
    console.error(`Failed to send notifications webhook: ${err.message}`);
    process.exit(1);
  }
}

main();

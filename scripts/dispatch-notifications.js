#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function main() {
  const apiUrl = process.env.NOTIFICATIONS_API_URL || 'https://meetings.tampamonitor.com/api/notify';
  const secret = process.env.WEBHOOK_SECRET;

  if (!secret) {
    console.error('Error: WEBHOOK_SECRET environment variable is not defined.');
    process.exit(1);
  }

  console.log(`Checking for modified/new meeting JSON files...`);
  
  // Find staged files that match 'agenda-scraper/data/meeting_*.json'
  let stagedFilesStr = '';
  try {
    stagedFilesStr = execSync(
      "git diff --staged --diff-filter=AM --name-only -- 'agenda-scraper/data/meeting_*.json'",
      { encoding: 'utf8' }
    ).trim();
  } catch (err) {
    console.error(`Failed to get staged files via git: ${err.message}`);
    process.exit(1);
  }

  if (!stagedFilesStr) {
    console.log('No new or modified meeting JSON files found staged in git. Nothing to notify.');
    process.exit(0);
  }

  const filePaths = stagedFilesStr.split('\n').filter(Boolean);
  console.log(`Found ${filePaths.length} changed meeting file(s):`);
  for (const fp of filePaths) {
    console.log(`- ${fp}`);
  }

  const meetings = [];
  for (const relativePath of filePaths) {
    const fullPath = path.resolve(process.cwd(), relativePath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`Warning: File does not exist: ${relativePath}`);
      continue;
    }

    try {
      const fileContent = fs.readFileSync(fullPath, 'utf8');
      const data = JSON.parse(fileContent);
      
      // Keep only necessary fields to optimize payload size
      const parsedMeeting = {
        meetingId: data.meetingId,
        meetingType: data.meetingType || 'regular',
        meetingDate: data.meetingDate,
        sourceUrl: data.sourceUrl,
        agendaItems: (data.agendaItems || []).map(item => ({
          number: item.number,
          agendaItemId: item.agendaItemId,
          title: item.title,
          fileNumber: item.fileNumber,
          background: item.background || '',
          supportingDocuments: (item.supportingDocuments || []).map(doc => ({
            title: doc.title,
            url: doc.mirroredUrl || doc.url
          }))
        }))
      };
      
      meetings.push(parsedMeeting);
    } catch (err) {
      console.error(`Error reading/parsing ${relativePath}: ${err.message}`);
      process.exit(1);
    }
  }

  if (meetings.length === 0) {
    console.log('No valid meeting data parsed. Aborting notification dispatch.');
    process.exit(0);
  }

  const payload = { meetings };
  console.log(`Sending payload to ${apiUrl}...`);

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
    console.log(`Response Status: ${response.status} ${response.statusText}`);
    console.log(`Response Body: ${responseText}`);

    if (!response.ok) {
      throw new Error(`Server returned error status: ${response.status}`);
    }
    
    console.log('Notifications dispatched successfully!');
  } catch (err) {
    console.error(`Failed to send notifications webhook: ${err.message}`);
    process.exit(1);
  }
}

main();

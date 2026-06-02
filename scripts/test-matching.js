const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 1. Resolve database file paths relative to the script location
const repoRoot = path.resolve(__dirname, '..');
const d1Path = path.join(repoRoot, 'site/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/f738bc0d8d71a859dda96beaae4f4c81585ffaf79e6b30cce6ee95e4c475a891.sqlite');
const meetingsDbPath = path.join(repoRoot, 'data/meetings.db');

console.log(`Loading databases...`);
console.log(`D1 Database: ${d1Path}`);
console.log(`Meetings Database: ${meetingsDbPath}\n`);

if (!fs.existsSync(d1Path)) {
  console.error(`Error: D1 database file not found at ${d1Path}`);
  console.error(`Have you run the D1 migrations locally? Make sure to run:`);
  console.error(`cd site && npx wrangler d1 migrations apply tampa-meetings-notifications --local`);
  process.exit(1);
}
if (!fs.existsSync(meetingsDbPath)) {
  console.error(`Error: Meetings SQLite database file not found at ${meetingsDbPath}`);
  console.error(`Please run 'npm run build-db' to generate the SQLite database.`);
  process.exit(1);
}

// 2. Open SQLite database connections
const d1Db = new Database(d1Path);
const meetingsDb = new Database(meetingsDbPath);

// 3. Load active, verified keywords
const keywordRows = d1Db.prepare(`
  SELECT k.keyword, k.match_type, s.email, s.id as sub_id
  FROM keywords k
  JOIN subscriptions s ON k.subscription_id = s.id
  WHERE s.verified = 1
`).all();

if (keywordRows.length === 0) {
  console.log(`No verified keywords found in your local D1 database.`);
  console.log(`Please subscribe and verify a test user in the browser first.`);
  process.exit(0);
}

console.log(`Loaded ${keywordRows.length} active keyword subscription(s).`);

// Map normalized keyword key to subscriber emails
const keywordToSubscribers = {};
for (const row of keywordRows) {
  const normKeyword = row.keyword.trim().toLowerCase();
  const key = `${row.match_type}:${normKeyword}`;
  if (!keywordToSubscribers[key]) {
    keywordToSubscribers[key] = new Set();
  }
  keywordToSubscribers[key].add(row.email);
}

// Group unique keywords by matching types and compile expressions
const containsKeywords = [...new Set(
  keywordRows
    .filter(r => r.match_type === 'contains')
    .map(r => r.keyword.trim().toLowerCase())
)];
const exactKeywords = [...new Set(
  keywordRows
    .filter(r => r.match_type === 'exact_phrase')
    .map(r => r.keyword.trim().toLowerCase())
)];
const fileNumKeywords = [...new Set(
  keywordRows
    .filter(r => r.match_type === 'file_number')
    .map(r => r.keyword.trim().toLowerCase())
)];

const containsRegex = containsKeywords.length > 0
  ? new RegExp(containsKeywords.map(escapeRegExp).join('|'), 'gi')
  : null;

const exactRegex = exactKeywords.length > 0
  ? new RegExp(`\\b(${exactKeywords.map(escapeRegExp).join('|')})\\b`, 'gi')
  : null;

console.log(`Compiled matching engines:`);
console.log(`- Contains pattern: ${containsRegex || '(none)'}`);
console.log(`- Exact Phrase pattern: ${exactRegex || '(none)'}`);
console.log(`- File Numbers: ${fileNumKeywords.join(', ') || '(none)'}\n`);

// 4. Fetch all meetings & agenda items
console.log(`Scanning historical agenda database...`);
const agendaItems = meetingsDb.prepare(`
  SELECT a.id as item_id, a.file_number, a.title as item_title, a.background, a.staff_report, 
         m.id as meeting_id, m.date, m.meeting_type, m.title as meeting_title
  FROM agenda_items a
  JOIN meetings m ON a.meeting_id = m.id
  ORDER BY m.date DESC, a.item_number ASC
`).all();

console.log(`Found ${agendaItems.length} agenda items. Running matching engine...`);

// Fetch document titles grouped by agenda item ID to include in matching search
const docsRows = meetingsDb.prepare(`SELECT agenda_item_id, title FROM documents`).all();
const docsByItemId = {};
for (const doc of docsRows) {
  if (!docsByItemId[doc.agenda_item_id]) {
    docsByItemId[doc.agenda_item_id] = [];
  }
  docsByItemId[doc.agenda_item_id].push(doc.title);
}

const subscriberDigests = {};

// Scan items
for (const item of agendaItems) {
  const docTitles = docsByItemId[item.item_id] || [];
  
  const staffReport = item.staff_report ? JSON.parse(item.staff_report) : null;
  const staffReportText = staffReport ? [
    staffReport.currentZoning || '',
    staffReport.requestedZoning || '',
    staffReport.futureLandUse || '',
    staffReport.overlayDistrict || '',
    ...(staffReport.neighborhoodAssociations || []),
    ...(staffReport.waivers || []),
    staffReport.findings || ''
  ].join(' ') : '';

  // Construct single searchable text string (lowercased)
  const searchableText = [
    item.item_title || '',
    item.background || '',
    item.file_number || '',
    ...docTitles,
    staffReportText
  ].join(' ').toLowerCase();

  const matchedKeys = new Set();

  // A. Check substring match
  if (containsRegex) {
    const matches = searchableText.match(containsRegex) || [];
    for (const m of matches) {
      matchedKeys.add(`contains:${m}`);
    }
  }

  // B. Check exact phrase match (word boundaries)
  if (exactRegex) {
    const matches = searchableText.match(exactRegex) || [];
    for (const m of matches) {
      matchedKeys.add(`exact_phrase:${m}`);
    }
  }

  // C. Check file number match (prefix check)
  if (item.file_number) {
    const fileNumLower = item.file_number.toLowerCase();
    for (const kw of fileNumKeywords) {
      if (fileNumLower.startsWith(kw)) {
        matchedKeys.add(`file_number:${kw}`);
      }
    }
  }

  // If there are matches, link item back to matching subscribers
  if (matchedKeys.size > 0) {
    for (const matchKey of matchedKeys) {
      const subscribers = keywordToSubscribers[matchKey];
      if (!subscribers) continue;

      const [matchType, keyword] = matchKey.split(':');

      for (const email of subscribers) {
        if (!subscriberDigests[email]) {
          subscriberDigests[email] = [];
        }

        let existingItem = subscriberDigests[email].find(i => i.item_id === item.item_id);
        if (existingItem) {
          existingItem.matchedKeywords.add(keyword);
        } else {
          subscriberDigests[email].push({
            meeting_id: item.meeting_id,
            meeting_date: item.date,
            meeting_type: item.meeting_type,
            meeting_title: item.meeting_title,
            item_id: item.item_id,
            item_title: item.item_title,
            file_number: item.file_number,
            matchedKeywords: new Set([keyword])
          });
        }
      }
    }
  }
}

// 5. Output report results
console.log(`\n=========================================`);
console.log(`         KEYWORD MATCHING REPORT         `);
console.log(`=========================================\n`);

const subscribersList = Object.keys(subscriberDigests);
if (subscribersList.length === 0) {
  console.log(`No matches found for any active keywords against the historical database.`);
} else {
  let reportMarkdown = `# Historical Keyword Matching Report\n\n`;
  reportMarkdown += `Generated on: ${new Date().toISOString()}\n\n`;
  
  for (const email of subscribersList) {
    const matches = subscriberDigests[email];
    console.log(`Subscriber: ${email} (${matches.length} matches found)`);
    reportMarkdown += `## Subscriber: ${email} (${matches.length} matches)\n\n`;
    
    // Group matches by meeting ID
    const matchesByMeeting = {};
    for (const m of matches) {
      if (!matchesByMeeting[m.meeting_id]) {
        matchesByMeeting[m.meeting_id] = {
          title: m.meeting_title,
          date: m.meeting_date,
          type: m.meeting_type,
          items: []
        };
      }
      matchesByMeeting[m.meeting_id].items.push(m);
    }

    for (const meetingId of Object.keys(matchesByMeeting)) {
      const meet = matchesByMeeting[meetingId];
      console.log(`  - Meeting: ${meet.date} - ${meet.title} (${meet.type.toUpperCase()})`);
      reportMarkdown += `### ${meet.date} — ${meet.title} (${meet.type.toUpperCase()})\n\n`;
      
      for (const item of meet.items) {
        const keywordsList = Array.from(item.matchedKeywords).join(', ');
        console.log(`    * [Item] File: ${item.file_number || '(none)'} - Title: ${item.item_title.substring(0, 90)}...`);
        console.log(`      Matched keywords: [${keywordsList}]`);
        
        reportMarkdown += `* **File ${item.file_number || '(none)'}**: ${item.item_title}\n`;
        reportMarkdown += `  * Matched keywords: \`${keywordsList}\`\n\n`;
      }
    }
    console.log();
  }

  // Save report file
  const reportPath = path.join(repoRoot, 'docs/TEST-MATCHING-RESULTS.md');
  fs.writeFileSync(reportPath, reportMarkdown);
  console.log(`Report successfully written to docs/TEST-MATCHING-RESULTS.md`);
}
d1Db.close();
meetingsDb.close();

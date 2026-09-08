// Build a /api/notify payload from meeting 2824 (119 items — exercises the chunked dedup read)
// plus one item with no agendaItemId. Used by notifications.sh.
const fs = require('fs'); const path = require('path');
const dir = path.resolve(__dirname, '..', '..', '..', 'agenda-scraper', 'data');
const f = fs.readdirSync(dir).find(n => /^meeting_2824_/.test(n));
const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const items = data.agendaItems.map(i => ({ number: i.number, agendaItemId: i.agendaItemId, title: i.title, fileNumber: i.fileNumber, background: i.background || '', staffReport: i.staffReport || null, supportingDocuments: (i.supportingDocuments || []).map(d => ({ title: d.title })) }));
items.push({ number: 999, agendaItemId: null, title: 'Zebrafish habitat study on Bayshore Boulevard', fileNumber: 'CM26-99999', background: '', staffReport: null, supportingDocuments: [] });
const payload = { meetings: [{ meetingId: data.meetingId, meetingType: data.meetingType, meetingDate: data.formattedDate, wordpressUrl: null, agendaItems: items }] };
fs.writeFileSync(process.argv[2], JSON.stringify(payload));
console.log('items:', items.length, 'null-id items:', items.filter(i => !i.agendaItemId).length);

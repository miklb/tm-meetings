/**
 * Side-by-side evaluation of pdf-parse vs liteparse against meeting 2841 (2026-04-23).
 *
 * For each agenda item we:
 *   1. Identify the PDFs we currently parse:
 *        - "Summary Sheet Cover Sheet" (background + financial extraction)
 *        - Staff report (zoning + waivers + findings + new: neighborhoods)
 *   2. Run BOTH backends on each PDF.
 *   3. Run the existing higher-level parsers on each backend's output.
 *   4. Write outputs (raw text + parsed JSON) under output/liteparse-eval/.
 *   5. Print a delta summary so we can spot regressions/improvements.
 *
 * Usage:
 *   node scripts/eval-liteparse.js
 *   node scripts/eval-liteparse.js --meeting=path/to/meeting.json
 */

const fs = require('fs');
const path = require('path');

const {
  extractTextFromBuffer,
  extractTextFromUrl,
} = require('../lib/pdf-text-extractor');
const {
  identifyStaffReports,
  parseZoningData,
  parseNeighborhoodAssociations,
} = require('../staff-report-parser');
const { extractBackgroundSection } = require('../lib/summary-sheet-parser');

const DEFAULT_MEETING_FILE = path.join(
  __dirname,
  '..',
  'data',
  'meeting_2841_2026-04-23.json'
);
const OUTPUT_ROOT = path.join(__dirname, '..', 'output', 'liteparse-eval');
const BACKENDS = ['pdfparse', 'liteparse'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function findSummaryDoc(item) {
  if (!item.supportingDocuments) return null;
  return (
    item.supportingDocuments.find((doc) => {
      const haystack = `${doc.title || ''} ${doc.originalText || ''}`.toLowerCase();
      return haystack.includes('summary sheet') && haystack.includes('cover sheet');
    }) || null
  );
}

function findStaffReportDoc(item) {
  if (!item.supportingDocuments) return null;
  const all = item.supportingDocuments.filter((doc) =>
    (doc.title || '').toUpperCase().includes('STAFF REPORT')
  );
  if (!all.length) return null;
  // Prefer FINAL, then most recent by trailing dated patterns (cheap heuristic).
  const finals = all.filter((d) => /FINAL/i.test(d.title));
  return (finals[0] || all[all.length - 1]);
}

function pickUrl(doc) {
  // Prefer mirrored URL — already on R2, faster + no city site rate limits.
  return doc.mirroredUrl || doc.url;
}

async function downloadOnce(url) {
  const axios = require('axios');
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  return Buffer.from(res.data);
}

function summarizeText(text) {
  if (!text) return { length: 0, lines: 0, sample: '' };
  return {
    length: text.length,
    lines: text.split('\n').length,
    sample: text.slice(0, 240).replace(/\s+/g, ' ').trim(),
  };
}

async function runBackend(buffer, backend, label) {
  const t0 = Date.now();
  try {
    const result = await extractTextFromBuffer(buffer, { backend });
    return {
      backend,
      label,
      ok: true,
      ms: Date.now() - t0,
      text: result.text,
      pages: result.pages,
    };
  } catch (err) {
    return {
      backend,
      label,
      ok: false,
      ms: Date.now() - t0,
      error: err.message,
      text: '',
    };
  }
}

function parseSummary(text) {
  return extractBackgroundSection(text) || null;
}

async function evaluateItem(item, outDir) {
  const itemDir = path.join(outDir, String(item.agendaItemId));
  const sources = [];

  const summary = findSummaryDoc(item);
  if (summary) sources.push({ kind: 'summary-sheet', doc: summary });

  const staff = findStaffReportDoc(item);
  if (staff) sources.push({ kind: 'staff-report', doc: staff });

  if (!sources.length) return null;
  ensureDir(itemDir);

  const itemReport = {
    agendaItemId: item.agendaItemId,
    fileNumber: item.fileNumber,
    sources: [],
  };

  for (const source of sources) {
    const url = pickUrl(source.doc);
    if (!url) continue;
    console.log(`\n→ Item ${item.agendaItemId} (${item.fileNumber}) :: ${source.kind}`);
    console.log(`  URL: ${url}`);

    let buffer;
    try {
      buffer = await downloadOnce(url);
    } catch (err) {
      console.log(`  ! download failed: ${err.message}`);
      continue;
    }
    const header = buffer.slice(0, 5).toString('ascii');
    if (!header.startsWith('%PDF')) {
      console.log(`  ! skipping non-PDF (header=${header})`);
      continue;
    }

    const sourceReport = {
      kind: source.kind,
      title: source.doc.title,
      url,
      bytes: buffer.length,
      backends: {},
    };

    for (const backend of BACKENDS) {
      const r = await runBackend(buffer, backend, `${source.kind}/${backend}`);
      const fname = `${source.kind}.${backend}.txt`;
      fs.writeFileSync(path.join(itemDir, fname), r.text || `[ERROR] ${r.error}`);

      const summarized = summarizeText(r.text);
      const parsed =
        source.kind === 'staff-report'
          ? {
              ...parseZoningData(r.text, item.fileNumber),
              neighborhoodAssociations: parseNeighborhoodAssociations(r.text),
            }
          : { background: parseSummary(r.text) };

      sourceReport.backends[backend] = {
        ok: r.ok,
        ms: r.ms,
        pages: r.pages,
        ...summarized,
        parsed,
      };

      console.log(
        `  [${backend}] ${r.ok ? 'ok' : 'FAIL'} ${r.ms}ms  text=${summarized.length}c  pages=${r.pages || '?'}`
      );
    }

    itemReport.sources.push(sourceReport);
  }

  fs.writeFileSync(
    path.join(itemDir, 'report.json'),
    JSON.stringify(itemReport, null, 2)
  );
  return itemReport;
}

function deltaSummary(allReports) {
  const lines = [];
  lines.push('# liteparse vs pdf-parse — meeting 2841\n');
  for (const ir of allReports) {
    if (!ir) continue;
    lines.push(`## Item ${ir.agendaItemId} — ${ir.fileNumber}`);
    for (const s of ir.sources) {
      lines.push(`### ${s.kind} — ${s.title}`);
      const pp = s.backends.pdfparse || {};
      const lp = s.backends.liteparse || {};
      lines.push(
        `| backend | ok | ms | chars | pages |`,
        `|---|---|---|---|---|`,
        `| pdfparse  | ${pp.ok} | ${pp.ms} | ${pp.length || 0} | ${pp.pages || '?'} |`,
        `| liteparse | ${lp.ok} | ${lp.ms} | ${lp.length || 0} | ${lp.pages || '?'} |`
      );
      if (s.kind === 'staff-report') {
        const fields = [
          'currentZoning',
          'requestedZoning',
          'futureLandUse',
          'findings',
          'neighborhoodAssociations',
        ];
        lines.push('', '| field | pdfparse | liteparse |', '|---|---|---|');
        for (const f of fields) {
          const a = JSON.stringify(pp.parsed?.[f] ?? null);
          const b = JSON.stringify(lp.parsed?.[f] ?? null);
          const same = a === b ? '' : '  ⚠️';
          lines.push(`| ${f}${same} | ${truncate(a)} | ${truncate(b)} |`);
        }
      } else if (s.kind === 'summary-sheet') {
        lines.push('', '| field | pdfparse | liteparse |', '|---|---|---|');
        const a = JSON.stringify(pp.parsed?.background ?? null);
        const b = JSON.stringify(lp.parsed?.background ?? null);
        lines.push(`| background | ${truncate(a)} | ${truncate(b)} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function truncate(s, n = 140) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function main() {
  const meetingArg = process.argv.find((a) => a.startsWith('--meeting='));
  const meetingFile = meetingArg ? meetingArg.split('=')[1] : DEFAULT_MEETING_FILE;

  if (!fs.existsSync(meetingFile)) {
    console.error(`Meeting JSON not found: ${meetingFile}`);
    process.exit(1);
  }

  const meeting = JSON.parse(fs.readFileSync(meetingFile, 'utf8'));
  const outDir = path.join(OUTPUT_ROOT, `meeting-${meeting.meetingId}`);
  ensureDir(outDir);
  console.log(`Eval output → ${outDir}`);

  // Restrict to items that actually have something we parse
  const candidates = meeting.agendaItems.filter(
    (it) => findSummaryDoc(it) || findStaffReportDoc(it)
  );
  console.log(`Found ${candidates.length} candidate items in meeting ${meeting.meetingId}.`);

  const reports = [];
  for (const item of candidates) {
    const r = await evaluateItem(item, outDir);
    if (r) reports.push(r);
  }

  const summaryMd = deltaSummary(reports);
  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), summaryMd);
  console.log(`\nDone. Summary: ${path.join(outDir, 'SUMMARY.md')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

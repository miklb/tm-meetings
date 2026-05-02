/**
 * Unified PDF text extraction wrapper.
 *
 * Two backends:
 *   - pdfparse  (legacy, default — same behavior as before)
 *   - liteparse (new, https://github.com/run-llama/liteparse)
 *
 * Switch with the PDF_PARSER env var (PDF_PARSER=liteparse), or pass
 * `{ backend: 'liteparse' }` per call. This lets us A/B test before
 * making liteparse the default.
 *
 * All entry points return: { text, pages, backend }
 *   - text  : extracted plain text
 *   - pages : page count when available, else null
 *   - backend: which backend produced the result
 */

const fs = require('fs');
const axios = require('axios');

const DEFAULT_BACKEND = (process.env.PDF_PARSER || 'pdfparse').toLowerCase();
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

let liteParseInstancePromise = null;

async function getLiteParse(options = {}) {
  if (!liteParseInstancePromise) {
    // ESM-only package; load via dynamic import.
    liteParseInstancePromise = (async () => {
      const { LiteParse } = await import('@llamaindex/liteparse');
      return new LiteParse({
        ocrEnabled: options.ocrEnabled === true, // default off; we don't want surprise Tesseract downloads
        ...options,
      });
    })();
  }
  return liteParseInstancePromise;
}

/**
 * Silence chatty stdout/stderr while running a function.
 */
async function withSilencedOutput(fn) {
  const origLog = console.log;
  const origInfo = console.info;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = () => {};
  console.info = () => {};
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.info = origInfo;
    process.stderr.write = origStderrWrite;
  }
}

async function extractWithLiteParse(buffer, opts = {}) {
  const parser = await getLiteParse({ ocrEnabled: opts.ocrEnabled });
  const result = await withSilencedOutput(() => parser.parse(buffer));
  return {
    text: result.text || '',
    pages: Array.isArray(result.pages) ? result.pages.length : null,
    backend: 'liteparse',
    raw: result, // pages[].bboxes available for callers that want spatial info
  };
}

async function extractWithPdfParse(buffer, opts = {}) {
  // eslint-disable-next-line global-require
  const pdfParse = require('pdf-parse');
  const data = await withSilencedOutput(() =>
    pdfParse(buffer, opts.pdfParseOptions || {})
  );
  return {
    text: data.text || '',
    pages: data.numpages || null,
    backend: 'pdfparse',
    raw: data,
  };
}

async function extractTextFromBuffer(buffer, opts = {}) {
  const backend = (opts.backend || DEFAULT_BACKEND).toLowerCase();
  if (backend === 'liteparse') return extractWithLiteParse(buffer, opts);
  return extractWithPdfParse(buffer, opts);
}

async function extractTextFromUrl(url, opts = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: opts.timeout || 90000,
    headers: { 'User-Agent': DEFAULT_USER_AGENT, ...(opts.headers || {}) },
  });
  const buffer = Buffer.from(response.data);

  // Sanity check: must be a real PDF
  const header = buffer.slice(0, 5).toString('ascii');
  if (!header.startsWith('%PDF')) {
    throw new Error(`Not a PDF (header=${JSON.stringify(header)}): ${url}`);
  }

  return extractTextFromBuffer(buffer, opts);
}

async function extractTextFromFile(filePath, opts = {}) {
  return extractTextFromBuffer(fs.readFileSync(filePath), opts);
}

module.exports = {
  DEFAULT_BACKEND,
  extractTextFromBuffer,
  extractTextFromUrl,
  extractTextFromFile,
};

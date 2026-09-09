/**
 * Small retry helper for the scraper's HTTP fetches.
 *
 * OnBase drops or times out individual requests now and then; without a
 * retry, one dropped item-detail fetch turned into an agenda item with no
 * documents or background that the nightly then committed as truth.
 */

'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` up to `attempts` times, waiting `delayMs` (doubling) between tries.
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.attempts=2]
 * @param {number} [options.delayMs=1500]
 * @param {string} [options.label]      used in the retry log line
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<T>}
 * @template T
 */
async function withRetry(fn, { attempts = 2, delayMs = 1500, label = 'request', log = console.warn } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        log(`[HTTP] ${label} failed (attempt ${attempt}/${attempts}): ${err.message} — retrying`);
        await sleep(delayMs * attempt);
      }
    }
  }
  throw lastErr;
}

module.exports = { withRetry };

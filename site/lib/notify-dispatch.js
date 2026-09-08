// Sends the digests and records the notification log per successful batch.
//
// The old order was "send every batch, then write every log row". If batch
// 3 of 4 failed, the function returned 500 with nothing logged, and the
// retry re-sent batches 1 and 2 to people who already had the email. Now
// each batch's log rows are written as soon as that batch is accepted by
// Resend, so a retry only sends what was never sent.
//
// Pure orchestration: the HTTP call and the D1 write are injected so this
// can be tested without either.

import { chunk } from './keyword-matcher.js';

export const RESEND_BATCH_SIZE = 100;

/**
 * @param {object} args
 * @param {Array<{ to: string }>} args.emails         one message per subscriber
 * @param {Map<string, Array<object>>} args.logsByEmail  log rows to write once that subscriber's email is sent
 * @param {(batch: Array<object>) => Promise<void>} args.sendBatch  throws on failure
 * @param {(rows: Array<object>) => Promise<void>} args.writeLogs   throws on failure
 * @param {(msg: string) => void} [args.warn]
 * @returns {Promise<{ sent: number, logged: number, failedBatch: null | { index: number, size: number, error: string } }>}
 */
export async function dispatchDigests({ emails, logsByEmail, sendBatch, writeLogs, warn = () => {} }) {
  const result = { sent: 0, logged: 0, failedBatch: null };
  const batches = chunk(emails, RESEND_BATCH_SIZE);

  for (const [index, batch] of batches.entries()) {
    try {
      await sendBatch(batch);
    } catch (err) {
      result.failedBatch = { index, size: batch.length, error: err.message };
      return result;
    }
    result.sent += batch.length;

    const rows = batch.flatMap(email => logsByEmail.get(email.to) || []);
    if (rows.length === 0) continue;
    try {
      await writeLogs(rows);
      result.logged += rows.length;
    } catch (err) {
      // The emails went out; losing the log means a possible duplicate later,
      // which is the lesser harm. Say so loudly.
      warn(`notification_log write failed for batch ${index + 1}/${batches.length} (${rows.length} rows): ${err.message}`);
    }
  }
  return result;
}

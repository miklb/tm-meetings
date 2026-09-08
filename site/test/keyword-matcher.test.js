// Tests for site/lib/keyword-matcher.js and notify-dispatch.js — `npm test`.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../lib/keyword-matcher.js');
const { dispatchDigests } = require('../lib/notify-dispatch.js');

const kw = (keyword, matchType = 'contains') => ({ keyword, matchType });
const item = (title, extra = {}) => ({ agendaItemId: '1', number: 1, title, ...extra });

test('contains keywords match substrings; short keywords match whole words with optional plural', () => {
  const matchers = m.buildMatchers([kw('zoning'), kw('mou'), kw('cra')]);
  assert.deepEqual([...m.matchItem(item('Rezoning petition and two MOUs'), matchers)].sort(), ['contains:mou', 'contains:zoning']);
  assert.deepEqual([...m.matchItem(item('The amount is large'), matchers)], [], '"mou" must not fire inside "amount"');
  assert.deepEqual([...m.matchItem(item('CRA Board update'), matchers)], ['contains:cra']);
});

test('street suffixes match across their abbreviations, in either direction', () => {
  const matchers = m.buildMatchers([kw('bayshore blvd'), kw('kennedy boulevard')]);
  const hits = (t) => [...m.matchItem(item(t), matchers)].sort();
  assert.deepEqual(hits('Bayshore Boulevard improvements'), ['contains:bayshore blvd']);
  assert.deepEqual(hits('at Bayshore Blvd. and Bay'), ['contains:bayshore blvd']);
  assert.deepEqual(hits('Kennedy Blvd corridor'), ['contains:kennedy boulevard']);
});

test('exact_phrase requires word boundaries; file_number requires equality', () => {
  const matchers = m.buildMatchers([kw('west tampa', 'exact_phrase'), kw('rez-26-05', 'file_number')]);
  assert.deepEqual([...m.matchItem(item('West Tampa CRA'), matchers)], ['exact_phrase:west tampa']);
  assert.deepEqual([...m.matchItem(item('Westtampa'), matchers)], []);
  assert.deepEqual([...m.matchItem(item('x', { fileNumber: 'REZ-26-05' }), matchers)], ['file_number:rez-26-05']);
  assert.deepEqual([...m.matchItem(item('x', { fileNumber: 'REZ-26-050' }), matchers)], []);
});

test('searchableText includes documents and staff report fields but not across field boundaries', () => {
  const it = item('Bayshore', {
    supportingDocuments: [{ title: 'Boulevard study.pdf' }],
    staffReport: { neighborhoodAssociations: ['Hyde Park'], waivers: ['setback'] },
  });
  const text = m.searchableText(it);
  assert.ok(text.includes('hyde park') && text.includes('setback') && text.includes('boulevard study'));
  const matchers = m.buildMatchers([kw('bayshore boulevard'), kw('hyde park')]);
  assert.deepEqual([...m.matchItem(it, matchers)], ['contains:hyde park'], 'multi-word keyword must not span title and document title');
});

test('splitMatchKey splits on the first colon only', () => {
  assert.deepEqual(m.splitMatchKey('contains:re: budget'), { matchType: 'contains', keyword: 're: budget' });
});

test('itemKey falls back to the item number when there is no agendaItemId', () => {
  assert.equal(m.itemKey({ agendaItemId: '24871', number: 3 }), '24871');
  assert.equal(m.itemKey({ agendaItemId: null, number: 7 }), 'n7');
  assert.equal(m.itemKey({ agendaItemId: undefined, number: 8 }), 'n8');
  assert.notEqual(m.itemKey({ number: 1 }), m.itemKey({ number: 2 }));
});

test('eligibility: one rule for every mode', () => {
  const now = new Date('2026-09-08T00:00:00Z');
  const supporter = { isSupporter: true, supporterActiveUntil: null, isBetaTester: false };
  const lapsed = { isSupporter: true, supporterActiveUntil: '2026-01-01', isBetaTester: false };
  const beta = { isSupporter: false, supporterActiveUntil: null, isBetaTester: true };
  const nobody = { isSupporter: false, supporterActiveUntil: null, isBetaTester: false };
  for (const mode of ['PUBLIC', 'BETA_AND_SUPPORTERS', 'SUPPORTERS_ONLY']) {
    assert.equal(m.eligibility(supporter, mode, now).allowed, true, `supporter in ${mode}`);
    assert.equal(m.eligibility(supporter, mode, now).limit, 15);
  }
  assert.equal(m.eligibility(lapsed, 'SUPPORTERS_ONLY', now).allowed, false);
  assert.equal(m.eligibility(lapsed, 'PUBLIC', now).allowed, true);
  assert.equal(m.eligibility(beta, 'BETA_AND_SUPPORTERS', now).allowed, true);
  assert.equal(m.eligibility(beta, 'SUPPORTERS_ONLY', now).allowed, false, 'beta testers are not admitted in SUPPORTERS_ONLY (notify used to)');
  assert.equal(m.eligibility(nobody, 'PUBLIC', now).allowed, true);
  assert.equal(m.eligibility(nobody, 'BETA_AND_SUPPORTERS', now).allowed, false);
  assert.equal(m.eligibilityFromRow({ supporter_email: 'a@b', supporter_active_until: null, is_beta_tester: 0 }, 'SUPPORTERS_ONLY', now).allowed, true);
  assert.equal(m.eligibilityFromRow({ supporter_email: null, supporter_active_until: null, is_beta_tester: 1 }, 'SUPPORTERS_ONLY', now).allowed, false);
});

test('chunk splits under the D1 bind limit', () => {
  const ids = Array.from({ length: 119 }, (_, i) => String(i));
  const chunks = m.chunk(ids, m.D1_MAX_BINDS);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(c => c.length <= 90));
  assert.equal(chunks.flat().length, 119);
  assert.deepEqual(m.chunk([], 90), []);
});

// ---------------------------------------------------------------------------
// dispatchDigests
// ---------------------------------------------------------------------------

function fixture(n) {
  const emails = Array.from({ length: n }, (_, i) => ({ to: `u${i}@x.test`, subject: 's' }));
  const logsByEmail = new Map(emails.map(e => [e.to, [{ subscriptionId: e.to, agendaItemId: '1', keyword: 'k' }]]));
  return { emails, logsByEmail };
}

test('logs are written per successful batch, so a later failure leaves earlier sends logged', async () => {
  const { emails, logsByEmail } = fixture(250); // 3 batches: 100, 100, 50
  const written = [];
  let call = 0;
  const r = await dispatchDigests({
    emails, logsByEmail,
    sendBatch: async () => { call++; if (call === 3) throw new Error('Resend 500'); },
    writeLogs: async (rows) => { written.push(rows.length); },
  });
  assert.deepEqual(written, [100, 100]);
  assert.equal(r.sent, 200);
  assert.equal(r.logged, 200);
  assert.deepEqual(r.failedBatch, { index: 2, size: 50, error: 'Resend 500' });
});

test('a log write failure after a successful send is reported but does not stop dispatch', async () => {
  const { emails, logsByEmail } = fixture(150);
  const warnings = [];
  let writes = 0;
  const r = await dispatchDigests({
    emails, logsByEmail,
    sendBatch: async () => {},
    writeLogs: async () => { writes++; if (writes === 1) throw new Error('D1 busy'); },
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(r.sent, 150);
  assert.equal(r.logged, 50);
  assert.equal(r.failedBatch, null);
  assert.match(warnings[0], /batch 1\/2 .*D1 busy/);
});

test('all batches succeed', async () => {
  const { emails, logsByEmail } = fixture(3);
  const r = await dispatchDigests({ emails, logsByEmail, sendBatch: async () => {}, writeLogs: async () => {} });
  assert.deepEqual(r, { sent: 3, logged: 3, failedBatch: null });
});

// Turnstile *site* key — public by design (ships in the page HTML, domain-locked
// in the Cloudflare dashboard), so it is safe to commit. The env var remains as
// an override for testing against a different widget.
// The paired TURNSTILE_SECRET_KEY is a Pages secret and must never appear here.
const DEFAULT_SITE_KEY = '0x4AAAAAADxZ0A24UQZfEmB9';

const siteKey = process.env.TURNSTILE_SITE_KEY || DEFAULT_SITE_KEY;

if (!siteKey) {
  // A widget-less page fails closed server-side: every signup gets
  // "Bot verification failed". Never ship that silently.
  throw new Error('turnstile.js: no Turnstile site key — refusing to build a widget-less notifications page');
}

module.exports = { siteKey };

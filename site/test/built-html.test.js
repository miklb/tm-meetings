// Checks on the built site (site/_site). Builds it first, so this needs
// data/meetings.db (npm run build-db); without the DB the suite is skipped.
// Run: npm test (root) or node --test site/test/built-html.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SITE = path.resolve(new URL('..', import.meta.url).pathname);
const OUT = path.join(SITE, '_site');
const DB = path.join(SITE, '..', 'data', 'meetings.db');

function collect(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

if (!fs.existsSync(DB)) {
  test('built HTML checks', { skip: 'data/meetings.db not present — run npm run build-db first' }, () => {});
} else {
  execFileSync('npx', ['@11ty/eleventy', '--quiet'], { cwd: SITE, stdio: 'ignore' });
  const pages = collect(OUT).map((file) => ({
    url: '/' + path.relative(OUT, file).replace(/index\.html$/, ''),
    html: fs.readFileSync(file, 'utf8'),
  }));
  const meetingPages = pages.filter((p) => p.url.startsWith('/meetings/'));
  const mediaPages = meetingPages.filter((p) => p.html.includes('class="meeting-layout"'));

  test('site built with meeting pages', () => {
    assert.ok(pages.length > 10, `only ${pages.length} pages`);
    assert.ok(mediaPages.length > 0, 'no meeting page with media');
  });

  test('every page has exactly one h1', () => {
    for (const p of pages) {
      const n = (p.html.match(/<h1[\s>]/g) || []).length;
      assert.equal(n, 1, `${p.url}: ${n} h1`);
    }
  });

  test('no duplicate element ids on any page', () => {
    for (const p of pages) {
      const seen = new Map();
      for (const m of p.html.matchAll(/\sid="([^"]*)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      const dupes = [...seen].filter(([id, n]) => n > 1 || id === '');
      assert.deepEqual(dupes, [], `${p.url}: duplicate ids ${JSON.stringify(dupes.slice(0, 5))}`);
    }
  });

  test('no inline event handlers anywhere', () => {
    for (const p of pages) {
      const m = p.html.match(/\son(click|keydown|change|submit|load)=/i);
      assert.equal(m, null, `${p.url}: inline ${m && m[0]}`);
    }
  });

  test('agenda is rendered once and the drawer starts hidden and inert', () => {
    for (const p of mediaPages) {
      const lists = (p.html.match(/<ol class="agenda-list">/g) || []).length;
      assert.ok(lists <= 1, `${p.url}: agenda list rendered ${lists} times`);
      if (p.html.includes('id="agenda-drawer"')) {
        assert.match(p.html, /<aside id="agenda-drawer"[^>]*\shidden\b/, `${p.url}: drawer not hidden`);
        assert.match(p.html, /<aside id="agenda-drawer"[^>]*\sinert\b/, `${p.url}: drawer not inert`);
        assert.match(p.html, /<button class="agenda-trigger"[^>]*\shidden\b/, `${p.url}: trigger not hidden`);
        assert.match(p.html, /<section class="agenda-fallback" id="agenda"/, `${p.url}: no inline agenda`);
      }
      assert.doesNotMatch(p.html, /<noscript>\s*<section class="agenda-fallback"/, `${p.url}: agenda still duplicated in noscript`);
    }
  });

  test('transcript timestamps and chapters are real links to the video', () => {
    for (const p of mediaPages) {
      for (const m of p.html.matchAll(/<a class="transcript-timestamp"([^>]*)>/g)) {
        assert.match(m[1], /href="https:\/\/youtu\.be\/[\w-]+\?t=\d+"/, `${p.url}: timestamp without a video href`);
      }
      for (const m of p.html.matchAll(/<a class="chapter-item"([^>]*)>/g)) {
        assert.match(m[1], /href="https:\/\/youtu\.be\/[\w-]+\?t=\d+"/, `${p.url}: chapter without a video href`);
        assert.match(m[1], /data-video-part="\d+"/, `${p.url}: chapter without a part`);
      }
    }
  });

  test('video part tabs use a roving tabindex', () => {
    for (const p of mediaPages) {
      const tabs = [...p.html.matchAll(/<button class="video-tab[^"]*"([^>]*)>/g)];
      if (tabs.length === 0) continue;
      const active = tabs.filter((t) => /tabindex="0"/.test(t[1]));
      assert.equal(active.length, 1, `${p.url}: ${active.length} tabs with tabindex=0`);
    }
  });

  test('notifications page: labels, noscript, external script and stylesheet', () => {
    const p = pages.find((x) => x.url === '/notifications/');
    assert.ok(p, 'notifications page missing');
    assert.doesNotMatch(p.html, /<label(?![^>]*\sfor=)/, 'label without for');
    assert.match(p.html, /<noscript>/);
    assert.match(p.html, /<script src="\/js\/notifications\.js" defer>/);
    assert.doesNotMatch(p.html, /<style>/, 'inline style block');
    assert.doesNotMatch(p.html, /innerHTML/, 'inline script');
  });

  test('404 page and security headers ship', () => {
    assert.ok(fs.existsSync(path.join(OUT, '404.html')), '404.html');
    const headers = fs.readFileSync(path.join(OUT, '_headers'), 'utf8');
    for (const h of ['X-Frame-Options', 'Permissions-Policy', 'X-Content-Type-Options', 'Referrer-Policy']) {
      assert.match(headers, new RegExp(h), `_headers lacks ${h}`);
    }
  });

  test('no unconditional view-transition rule in the legacy stylesheet', () => {
    const css = fs.readFileSync(path.join(OUT, 'css', 'style.css'), 'utf8');
    assert.doesNotMatch(css, /@view-transition/);
    const base = fs.readFileSync(path.join(OUT, 'css', 'base.css'), 'utf8');
    assert.match(base, /prefers-reduced-motion: reduce\)\s*\{\s*@view-transition/);
  });

  // ── Land use board pages ──
  const VRB_DATA = path.join(SITE, '..', 'agenda-scraper', 'data', 'vrb');
  const rawHearings = fs.existsSync(VRB_DATA)
    ? fs.readdirSync(VRB_DATA).filter((f) => /^vrb_.*\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(VRB_DATA, f), 'utf8')))
    : [];
  const boardPages = pages.filter((p) => p.url.startsWith('/boards/'));
  const decode = (html) => html.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

  test('board pages: one per collected hearing, plus the index, linked from the nav', { skip: !rawHearings.length && 'no VRB data' }, () => {
    for (const h of rawHearings) {
      assert.ok(boardPages.some((p) => p.url === `/boards/vrb/${h.hearingDate}/`), `no page for ${h.hearingDate}`);
    }
    assert.ok(boardPages.some((p) => p.url === '/boards/'));
    assert.match(pages.find((p) => p.url === '/').html, /<a href="\/boards\/"/);
  });

  test('board pages never print an owner or applicant name, or a folio', { skip: !rawHearings.length && 'no VRB data' }, () => {
    const secrets = new Set();
    for (const h of rawHearings) {
      for (const c of h.cases) {
        for (const name of [c.owner, c.applicant, c.ownerApplicant]) {
          if (name && !/^confidential$/i.test(name)) secrets.add(name);
        }
        if (c.folio) secrets.add(c.folio);
      }
    }
    // The City itself owns one January 2026 case, and "City of Tampa" is in
    // the site chrome. Words the site prints on its non-board pages are not
    // secrets; nothing else may be excused this way.
    const chrome = decode(pages.find((p) => p.url === '/about/').html);
    const excused = [...secrets].filter((secret) => chrome.includes(secret));
    assert.deepEqual(excused, ['City of Tampa']);
    excused.forEach((secret) => secrets.delete(secret));
    assert.ok(secrets.size > 100, `only ${secrets.size} names/folios to check against`);
    for (const p of boardPages) {
      const text = decode(p.html);
      for (const secret of secrets) assert.ok(!text.includes(secret), `${p.url} prints "${secret}"`);
    }
  });

  test('board pages: a withheld case has no map or permit link; case anchors are unique', { skip: !rawHearings.length && 'no VRB data' }, () => {
    let withheld = 0;
    for (const p of boardPages.filter((x) => x.url !== '/boards/')) {
      const ids = [...p.html.matchAll(/<li class="case" id="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(new Set(ids).size, ids.length, `${p.url}: duplicate case ids`);
      for (const item of p.html.split('<li class="case"').slice(1)) {
        if (!item.includes('Address withheld by the City')) continue;
        withheld++;
        const own = item.split('</li>')[0];
        assert.ok(!/openstreetmap|accela/i.test(own), `${p.url}: withheld case carries a location link`);
      }
    }
    const expected = rawHearings.flatMap((h) => h.cases).filter((c) => c.locationWithheld).length;
    assert.equal(withheld, expected);
  });

  test('board map: one pin per located case, none for a withheld one, and every pin can link to its case', { skip: !rawHearings.length && 'no VRB data' }, () => {
    for (const h of rawHearings) {
      const p = boardPages.find((x) => x.url === `/boards/vrb/${h.hearingDate}/`);
      const mount = (p.html.match(/<div class="mapbox-block"[^>]*>/) || [''])[0];
      const located = h.cases.filter((c) => c.geo && !c.locationWithheld);
      if (!located.length) { assert.equal(mount, ''); continue; }

      assert.ok(p.html.includes('/assets/js/map-loader.js'), `${p.url}: map loader missing`);
      const pins = mount.match(/data-folios="([^"]*)"/)[1].split('|');
      assert.equal(pins.length, located.length, `${p.url}: pins`);
      for (const c of h.cases.filter((x) => x.locationWithheld)) {
        assert.ok(!mount.includes(c.caseNumber), `${p.url}: withheld ${c.caseNumber} is on the map`);
      }
      // maps.js resolves "RECORDID:N" to the .agenda-item__anchor whose text is N
      for (const entry of mount.match(/data-records="([^"]*)"/)[1].split(', ')) {
        const n = entry.split(':')[1];
        assert.match(p.html, new RegExp(`agenda-item__anchor"[^>]*>${n}<`), `${p.url}: no anchor for item ${n}`);
      }
    }
    assert.ok(fs.existsSync(path.join(OUT, 'assets', 'js', 'maps.js')));
  });
}

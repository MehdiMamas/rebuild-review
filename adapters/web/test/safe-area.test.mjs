// Safe-area probe on two fixture pages: a fixed header at top:0 under viewport-fit=cover must fail,
// and the same page with padding-top: env(safe-area-inset-top) must pass. Both modes: browser and standalone.
// Run: node --test test/safe-area.test.mjs (from adapters/web)
import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { chromium } from 'playwright';
import { safeAreaProbes } from '../probes.mjs';

const page = (headerCss) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>fixture</title>
<style>
  body { margin: 0; font: 16px sans-serif; }
  header { position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #eee; box-sizing: border-box; display: flex; gap: 8px; align-items: center; }
  main { padding-top: 120px; }
  ${headerCss}
</style></head><body>
<header><button id="menu">Menu</button><button id="new">New chat</button></header>
<main><button id="body-btn">Body button</button></main>
</body></html>`;

const pages = {
  '/bad': page(''),
  '/good': page('header { padding-top: env(safe-area-inset-top); height: calc(56px + env(safe-area-inset-top)); }'),
  // No viewport-fit=cover: Safari keeps the layout inside the insets, so the same header is not flagged.
  '/plain': page('').replace(',viewport-fit=cover', ''),
  // Cover page whose button sits mid-screen under a transparent full-screen layer: the centre test must catch it.
  '/covered': page('.shield { position: fixed; inset: 0; background: transparent; z-index: 5; } #body-btn { margin-top: 300px; display: block; }')
    .replace('<main><button id="body-btn">Body button</button></main>', '<main><button id="body-btn">Body button</button></main><div class="shield"></div>'),
};

// Scrolling fixtures: a cover page with a body style and body markup.
const doc = (css, body) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>fixture</title>
<style>body { margin: 0; font: 16px sans-serif; } button { height: 34px; position: absolute; left: 10px; } ${css}</style></head><body>${body}</body></html>`;
const at = (id, y, extra = '') => `<button id="${id}" style="top:${y}px;${extra}">${id}</button>`;
const spacer = (h) => `<div style="height:${h}px"></div>`;
Object.assign(pages, {
  // Mid-page in-flow buttons: one crosses y 810-844 at load, the page scrolls clear of the insets.
  '/scroll-mid': doc('', spacer(3000) + at('mid', 800) + at('top', 120)),
  '/fixed-bottom': doc('footer { position: fixed; bottom: 0; left: 0; right: 0; height: 50px; }', spacer(1500) + '<footer><button id="bar" style="position:static">Bar</button></footer>'),
  // Last in-flow button ends at the page end, under the bottom inset, with no padding.
  '/scroll-end': doc('', `<div style="height:2000px"></div><button id="last" style="position:static;display:block">Last</button>`),
  '/sticky-footer': doc('footer { position: sticky; bottom: 0; height: 50px; }', spacer(1500) + '<footer><button id="bar" style="position:static">Bar</button></footer>'),
  '/body-hidden': doc('html, body { height: 100%; overflow: hidden; }', `<div style="height:3000px">${at('mid', 400)}${at('low', 800)}</div>`),
  // Crosses y 810-844 at load; the page scrolls 56px, enough to clear it. Judged at load it would fail.
  '/absolute-end': doc('', spacer(900) + at('abs', 790)),
  // Skip link parked above the page top: it can never be seen, so it is not judged.
  '/skip-link': doc('', spacer(1500) + at('skip', -100)),
});

const server = http.createServer((req, res) => {
  const body = pages[req.url];
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const run = (route) => safeAreaProbes({ browser, origin, screens: [{ id: route.slice(1), url: route }], notChecked: [], idleMs: 1000 });

test.after(async () => { await browser.close(); server.close(); });

test('a fixed header under the status bar fails in both modes', async () => {
  const rows = await run('/bad');
  assert.strictEqual(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) {
    assert.strictEqual(row.probe, 'safe-area');
    assert.strictEqual(row.passed, false, `${row.screen}: ${row.evidence}`);
    assert.match(row.evidence, /top inset/, row.evidence);
    assert.match(row.evidence, /#menu|#new/, row.evidence);
  }
  assert.deepStrictEqual(rows.map((r) => r.screen), ['bad:browser', 'bad:standalone']);
});

test('a page that does not opt into viewport-fit=cover is not flagged for its bands', async () => {
  const rows = await run('/plain');
  assert.strictEqual(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) {
    assert.strictEqual(row.passed, true, `${row.screen}: ${row.evidence}`);
    assert.match(row.evidence, /lacks viewport-fit=cover/, row.evidence);
  }
});

test('a control covered at its centre by another element fails', async () => {
  const rows = await run('/covered');
  for (const row of rows) {
    assert.strictEqual(row.passed, false, `${row.screen}: ${row.evidence}`);
    assert.match(row.evidence, /covered at its centre by div\.shield/, row.evidence);
  }
});

test('the same header padded by the safe-area inset passes in both modes', async () => {
  const rows = await run('/good');
  assert.strictEqual(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) assert.strictEqual(row.passed, true, `${row.screen}: ${row.evidence}`);
});

const failing = (rows) => rows.forEach((row) => assert.strictEqual(row.passed, false, `${row.screen}: ${row.evidence}`));

test('a long page whose mid-page in-flow button crosses the bottom inset at load passes in both modes', async () => {
  const rows = await run('/scroll-mid');
  assert.strictEqual(rows.length, 2);
  for (const row of rows) assert.strictEqual(row.passed, true, `${row.screen}: ${row.evidence}`);
});

test('a fixed bottom bar with no safe-area padding fails naming the bottom inset', async () => {
  const rows = await run('/fixed-bottom');
  failing(rows);
  for (const row of rows) assert.match(row.evidence, /#bar.*bottom inset/, row.evidence);
});

test('the last in-flow button under the bottom inset at the scroll end fails as cannot be scrolled clear', async () => {
  const rows = await run('/scroll-end');
  failing(rows);
  for (const row of rows) assert.match(row.evidence, /#last.*bottom inset \(cannot be scrolled clear/, row.evidence);
});

test('a sticky footer at bottom 0 with no safe-area padding fails', async () => {
  const rows = await run('/sticky-footer');
  failing(rows);
  for (const row of rows) assert.match(row.evidence, /#bar.*bottom inset/, row.evidence);
});

test('overflow hidden on body judges in-flow controls with no scroll', async () => {
  const rows = await run('/body-hidden');
  failing(rows);
  for (const row of rows) {
    assert.match(row.evidence, /#low.*cannot be scrolled clear/, row.evidence);
    assert.doesNotMatch(row.evidence, /#mid/, row.evidence);
  }
});

test('an absolutely positioned button near the end of a scrolling page passes', async () => {
  const rows = await run('/absolute-end');
  for (const row of rows) assert.strictEqual(row.passed, true, `${row.screen}: ${row.evidence}`);
});

test('a control parked above the page top is not judged', async () => {
  const rows = await run('/skip-link');
  for (const row of rows) assert.strictEqual(row.passed, true, `${row.screen}: ${row.evidence}`);
});

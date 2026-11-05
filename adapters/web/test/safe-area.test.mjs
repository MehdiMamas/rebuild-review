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

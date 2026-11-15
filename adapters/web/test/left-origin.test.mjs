import test from 'node:test';
import assert from 'node:assert/strict';
import { leftOrigin } from '../probes.mjs';

test('same origin is not left', () => {
  assert.equal(leftOrigin('http://localhost:3000/a', 'http://localhost:3000/b?x=1'), false);
});
test('another origin is left', () => {
  assert.equal(leftOrigin('http://localhost:3000/a', 'http://localhost:4000/reports'), true);
});
test('unreadable or blank urls are not judged as left', () => {
  assert.equal(leftOrigin('http://localhost:3000/a', 'about:blank'), false);
  assert.equal(leftOrigin('', 'http://localhost:3000/'), false);
});

// Click probes on a page whose links go to a server on another port: same tab and target=_blank.
import http from 'node:http';
import { chromium } from 'playwright';
import { clickProbes } from '../probes.mjs';

const serve = (html) => new Promise((res) => { const s = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(html(q)); }); s.listen(0, '127.0.0.1', () => res(s)); });

test('a click that leaves the origin, in the same tab or a new window, is not checked', async () => {
  const other = await serve(() => '<title>other</title><p>elsewhere</p>');
  const base = `http://127.0.0.1:${other.address().port}/`;
  const main = await serve(() => `<title>main</title><a href="${base}">same tab</a> <a href="${base}" target="_blank">new window</a>`);
  const browser = await chromium.launch();
  try {
    const notChecked = [];
    const rows = await clickProbes({ browser, origin: `http://127.0.0.1:${main.address().port}`, screens: [{ id: 'home', url: '/' }], notChecked, allowOrigins: [new URL(base).origin] });
    const reasons = notChecked.map((n) => n.reason);
    assert.ok(reasons.some((r) => /click "same tab.*": the click went to another origin$/.test(r)), JSON.stringify(reasons));
    assert.ok(reasons.some((r) => /click "new window.*": the click went to another origin \(new window\)$/.test(r)), JSON.stringify(reasons));
    assert.equal(rows.filter((r) => r.probe !== 'repeat-requests').length, 0, JSON.stringify(rows));
  } finally { await browser.close(); main.close(); other.close(); }
});

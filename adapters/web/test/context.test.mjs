// A request to a URL that does not parse must be blocked and listed, never crash the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { makeContext, isDataRequest, locate } from '../context.mjs';

const BAD = 'https://not%20a%20url/account/needs-bootstrap';

test('isDataRequest accepts a URL that does not parse', () => {
  assert.equal(isDataRequest({ resourceType: () => 'fetch', headers: () => ({}), url: () => BAD }), true);
});

test('a fetch to a URL that does not parse is blocked, with and without faults', async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<p>hi</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    for (const faults of [{}, { slowMs: 1 }]) {
      const { context, rec } = await makeContext(browser, origin, { faults });
      const page = await context.newPage();
      await page.goto(origin);
      const failed = await page.evaluate((u) => fetch(u).then(() => false, () => true), BAD);
      assert.equal(failed, true);
      assert.equal(rec.blocked.length, 1);
      assert.match(rec.blocked[0], /not/);
      await context.close();
    }
    assert.deepEqual(uncaught, []);
  } finally {
    process.off('uncaughtException', onUncaught);
    await browser.close();
    server.close();
  }
});

test('locate waits for an element that renders after the load event, and still fails when it never comes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<script>setTimeout(() => { document.body.innerHTML = "<button>Try the demo</button>"; }, 1000)</script>');
    assert.equal(await (await locate(page, 'Try the demo')).textContent(), 'Try the demo');
    await assert.rejects(locate(page, 'Never here', 300), /nothing found by name or text: Never here/);
  } finally {
    await browser.close();
  }
});

import { envOrigins } from '../context.mjs';
test('envOrigins keeps loopback http(s) URLs of run.json env, once, never the app origin or remote hosts (#157)', () => {
  const env = { A: 'http://127.0.0.1:54321', B: 'http://127.0.0.1:54321/rest/v1', C: 'http://127.0.0.1:3000', D: 'https://x.supabase.co', E: 'not a url', F: 'sk-123', G: 'http://localhost:8080/x' };
  assert.deepEqual(envOrigins(env, 'http://127.0.0.1:3000'), ['http://127.0.0.1:54321', 'http://localhost:8080']);
  assert.deepEqual(envOrigins(undefined, 'http://127.0.0.1:3000'), []);
});

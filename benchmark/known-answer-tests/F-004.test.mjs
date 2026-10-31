// Known-answer test F-004 (D4): the count banner matches the last thing typed. Run by adapters/web/parity.mjs with APP_URL set.
import test from 'node:test';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_PATH || new URL('../../adapters/web/node_modules/playwright/index.mjs', import.meta.url).href);
const APP = process.env.APP_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withPage(fn, query = '') {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(8000);
    await page.goto(new URL('/' + query, APP).href);
    await fn(page);
  } finally { await browser.close(); }
}
const rows = (page) => page.waitForSelector('[data-testid=row]');

test("F-004 D4 the count banner matches the last thing typed", async () => {
 await withPage(async (page) => {
  await rows(page);
  await page.type('#search', 'ab');
  await sleep(2000);
  const text = await page.textContent('[data-testid=count]');
  assert.ok(text.includes('"ab"'), `banner reads: ${text}`);
 });
});

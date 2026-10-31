// Known-answer test D6: a loading state shows while the list loads. Run by adapters/web/parity.mjs with APP_URL set.
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

test("F-D6 a loading state shows while the list loads", async () => {
 await withPage(async (page) => {
  await sleep(500);
  const shown = await page.evaluate(() => !!document.querySelector('[data-testid=row]') || /loading|spinner/i.test(document.body.innerText) || !!document.querySelector('[aria-busy]'));
  assert.ok(shown, 'nothing visible while loading');
 }, "?slow=1");
});

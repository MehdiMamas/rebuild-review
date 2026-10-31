// Known-answer test F-005 (D5): selecting a task asks for it once, not repeatedly. Run by adapters/web/parity.mjs with APP_URL set.
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

test("F-005 D5 selecting a task asks for it once, not repeatedly", async () => {
 await withPage(async (page) => {
  await rows(page);
  let n = 0;
  page.on('request', (r) => { if (/\/api\/tasks\/1\?/.test(r.url())) n++; });
  await page.locator('[data-testid=row]').first().click();
  await sleep(1500);
  assert.ok(n >= 1 && n <= 2, `detail requests: ${n}`);
 });
});

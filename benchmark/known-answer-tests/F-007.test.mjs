// Known-answer test F-007 (D7): a failed save shows an error. Run by adapters/web/parity.mjs with APP_URL set.
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

test("F-007 D7 a failed save shows an error", async () => {
 await withPage(async (page) => {
  await page.locator('#save-settings').first().click();
  await sleep(800);
  const shown = await page.evaluate(() => !!document.querySelector('[role=alert]') || /error|failed/i.test(document.querySelector('.settings').innerText));
  assert.ok(shown, 'no error shown after the save failed');
 }, "?fail=save");
});

// Known-answer test F-008 (H1): the c key focuses the new-task input. Run by adapters/web/parity.mjs with APP_URL set.
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

test("F-008 H1 the c key focuses the new-task input", async () => {
 await withPage(async (page) => {
  await page.keyboard.press('c');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'new-task');
 });
});

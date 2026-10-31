// Known-answer test F-003 (D3): the list does not move when results load. Run by adapters/web/parity.mjs with APP_URL set.
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

test("F-003 D3 the list does not move when results load", async () => {
 await withPage(async (page) => {
  await sleep(300);
  const top1 = await page.evaluate(() => document.querySelector('.list').getBoundingClientRect().top);
  await rows(page);
  const top2 = await page.evaluate(() => document.querySelector('.list').getBoundingClientRect().top);
  assert.ok(top2 <= top1 + 1, `list top moved from ${top1} to ${top2}`);
 }, "?slow=1");
});

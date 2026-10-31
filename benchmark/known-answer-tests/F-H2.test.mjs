// Known-answer test H2: task titles are trimmed before they are stored. Run by adapters/web/parity.mjs with APP_URL set.
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

test("F-H2 task titles are trimmed before they are stored", async () => {
 await withPage(async (page) => {
  await rows(page);
  await page.fill('#new-task', '  padded  ');
  await page.press('#new-task', 'Enter');
  await sleep(500);
  const res = await (await fetch(new URL('/api/tasks?q=padded', APP))).json();
  assert.ok(res.items.length > 0 && res.items.at(-1).title === 'padded', JSON.stringify(res.items.at(-1)));
 });
});

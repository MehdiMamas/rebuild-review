// Observes every defect and hidden feature in answers.json in a real browser; bloat by grep.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const here = path.dirname(new URL(import.meta.url).pathname);
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const PORT = 4199;
const base = `http://127.0.0.1:${PORT}`;
const server = spawn('node', ['app/server.mjs'], { cwd: here, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

async function fresh(query = '') {
  const page = await browser.newPage();
  await page.goto(`${base}/${query}`);
  return page;
}

const checks = {
  async D1() {
    const page = await fresh();
    await page.waitForSelector('[data-testid=row]');
    const before = await page.evaluate(() => window.__renders);
    await page.type('#search', 'z');
    const after = await page.evaluate(() => window.__renders);
    return after - before >= 100;
  },
  async D2() {
    const page = await fresh();
    await page.click('#field-name');
    await page.keyboard.type('x');
    return (await page.evaluate(() => document.activeElement.tagName)) === 'BODY';
  },
  async D3() {
    const page = await fresh('?slow=1');
    await sleep(300);
    const top1 = await page.evaluate(() => document.querySelector('.list').getBoundingClientRect().top);
    await page.waitForSelector('[data-testid=row]');
    const top2 = await page.evaluate(() => document.querySelector('.list').getBoundingClientRect().top);
    return top2 > top1;
  },
  async D4() {
    const page = await fresh();
    await page.waitForSelector('[data-testid=row]');
    await page.type('#search', 'ab');
    await sleep(1500);
    const text = await page.textContent('[data-testid=count]');
    return text.includes('"a"') && (await page.inputValue('#search')) === 'ab';
  },
  async D5() {
    const page = await fresh();
    await page.waitForSelector('[data-testid=row]');
    let n = 0;
    page.on('request', (r) => r.url().includes('/api/tasks/1?') && n++);
    await page.click('[data-testid=row]');
    await sleep(1500);
    return n > 5;
  },
  async D6() {
    const page = await fresh('?slow=1');
    await sleep(500);
    return await page.evaluate(
      () => !document.querySelector('[data-testid=row]') && !/loading|spinner/i.test(document.body.innerText) && !document.querySelector('[aria-busy]'),
    );
  },
  async D7() {
    const page = await fresh('?fail=save');
    await page.click('#save-settings');
    await page.waitForSelector('[data-testid=saved]');
    return !(await page.$('[role=alert]')) && !/error|failed/i.test(await page.innerText('.settings'));
  },
  async H1() {
    const page = await fresh();
    await page.keyboard.press('c');
    return (await page.evaluate(() => document.activeElement.id)) === 'new-task';
  },
  async H2() {
    const page = await fresh();
    await page.fill('#new-task', '  padded  ');
    await page.press('#new-task', 'Enter');
    await sleep(300);
    const res = await (await fetch(`${base}/api/tasks?q=padded`)).json();
    const repo = execFileSync('node', ['init-history.mjs'], { cwd: here }).toString().trim();
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: repo }).toString();
    return res.items.length > 0 && res.items.at(-1).title === 'padded' && log.includes('Trim task titles: keep trailing spaces out of task titles');
  },
  async H3() {
    const page = await fresh('?fail=list');
    await page.waitForSelector('[data-testid=retry-banner]');
    return (await page.innerText('[data-testid=retry-banner]')).includes('Retry');
  },
  async H4() {
    const page = await fresh('?density=compact');
    return await page.evaluate(() => document.querySelector('.app').classList.contains('compact'));
  },
};

function grepCheck(g) {
  const run = (needle, where) => {
    try {
      return execFileSync('grep', ['-rF', needle, path.join(here, where), '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude=package-lock.json'], { stdio: 'pipe' }).toString().trim().length > 0;
    } catch {
      return false;
    }
  };
  return run(g.present[0], g.present[1]) && !run(g.absentIn[0], g.absentIn[1]);
}

for (const a of answers) {
  try {
    results[a.id] = a.kind === 'bloat' ? grepCheck(a.grep) : await checks[a.id]();
  } catch (e) {
    console.error(a.id, e.message);
    results[a.id] = false;
  }
  console.log(`${results[a.id] ? 'PASS' : 'FAIL'} ${a.id} ${a.kind}: ${a.what}`);
}
await browser.close();
server.kill();
const ok = Object.values(results).filter(Boolean).length;
console.log(`${ok}/${answers.length} observed`);
process.exit(ok === answers.length ? 0 : 1);

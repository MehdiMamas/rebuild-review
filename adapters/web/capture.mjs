// Web capture adapter. node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json]
// run.json: { platform: "web", dir?, install?, build?, start, address, appVersion? }; dir is relative to the run folder's work/.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeContext, runStep, sleep, scrub } from './context.mjs';
import { startApp } from './app.mjs';
import { runProbes } from './probes.mjs';
import { measureScreens } from './metrics.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const out = path.resolve(arg('out') || '');
const statesFile = arg('states');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'web') throw new Error(`web adapter cannot capture platform "${run.platform}"`);
const { origin, workDir, stop, buildMs } = await startApp(run, appFile);
const SIZES = [{ w: 390, h: 844 }, { w: 1440, h: 900 }];
const THEMES = ['light', 'dark'];
const MAX_SCREENS = Number(arg('max-screens')) || 30;
const MAX_BUTTONS = Number(arg('max-buttons')) || 10;
const MAX_HAR_BYTES = Number(arg('max-har-bytes')) || 50 * 1024 * 1024;
const notCaptured = [], cutScreens = [], skippedButtons = [];
const slug = (u) => { const p = new URL(u).pathname.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '-'); return p || 'root'; };
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };

const browser = await chromium.launch();
const har = [], consoleLines = [], blocked = new Set(), timings = [];
const shot = async (page, dir, name) => { fs.mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, `${name}.png`) }); };
async function settle(page) { await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); }
function collect(rec) {
  har.push(...rec.har);
  consoleLines.push(...rec.console.map((m) => `error ${m}`), ...rec.pageErrors.map((m) => `pageerror ${m}`));
  rec.blocked.forEach((b) => blocked.add(b));
}

// 1. Crawl: follow same-origin links, then click buttons to find routes that only a click reaches.
const start = new URL(run.address).toString();
const queue = [start], seen = new Map();
{
  const { context, rec } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  while (queue.length) {
    const url = queue.shift();
    const key = new URL(url).pathname + new URL(url).search;
    if (seen.has(key)) continue;
    if (seen.size >= MAX_SCREENS) {
      notCaptured.push(`crawl stopped at ${MAX_SCREENS} screens; ${url} not visited`);
      for (const u of [url, ...queue]) { const x = new URL(u), k = x.pathname + x.search; if (!seen.has(k) && !cutScreens.includes(k)) cutScreens.push(k); }
      break;
    }
    try { await page.goto(url); await settle(page); } catch (e) { notCaptured.push(`${url}: ${scrub(e.message).split('\n')[0]}`); seen.set(key, null); continue; }
    seen.set(key, { id: slug(url), url: key, title: await page.title() });
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
    const found = new Set(hrefs.filter((h) => new URL(h).origin === origin).map((h) => { const u = new URL(h); u.hash = ''; return u.toString(); }));
    const buttons = page.locator('button, [role=button]');
    const total = await buttons.count();
    if (total > MAX_BUTTONS) { notCaptured.push(`${key}: only the first ${MAX_BUTTONS} of ${total} buttons were tried`); skippedButtons.push({ screen: key, tried: MAX_BUTTONS, skipped: total - MAX_BUTTONS }); }
    for (let i = 0, n = Math.min(total, MAX_BUTTONS); i < n; i++) {
      try {
        await buttons.nth(i).click({ timeout: 1500 });
        await sleep(200);
        const u = new URL(page.url()); u.hash = '';
        if (u.origin === origin && u.pathname + u.search !== key) { found.add(u.toString()); await page.goto(url); await settle(page); }
      } catch {}
    }
    queue.push(...[...found].sort());
  }
  collect(rec);
  await context.close();
}
const screens = [...seen.values()].filter(Boolean);
const ids = new Set(); // keep ids unique
for (const s of screens) { let id = s.id, n = 2; while (ids.has(id)) id = `${s.id}-${n++}`; s.id = id; ids.add(id); }

// 2. Capture every screen at both sizes and themes.
for (const s of screens) {
  const dir = path.join(out, 'screens', s.id);
  for (const size of SIZES) for (const theme of THEMES) {
    const { context, rec } = await makeContext(browser, origin, { viewport: { width: size.w, height: size.h }, colorScheme: theme });
    const page = await context.newPage();
    try {
      await page.goto(new URL(s.url, origin).toString());
      await settle(page);
      await shot(page, dir, `${size.w}-${theme}`);
      if (size.w === 1440 && theme === 'light') {
        write(path.join(dir, 'render.html'), await page.content());
        write(path.join(dir, 'render.css.json'), await page.evaluate(() => [...document.body.querySelectorAll('*')].slice(0, 3000).map((e) => {
          const c = getComputedStyle(e), r = e.getBoundingClientRect();
          const p = {}; for (const k of ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'margin', 'padding', 'border', 'gap']) p[k] = c.getPropertyValue(k);
          return { tag: e.tagName.toLowerCase(), id: e.id || undefined, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], style: p };
        })));
        write(path.join(dir, 'a11y.json'), { ariaSnapshot: await page.locator('body').ariaSnapshot() });
        const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd } : {}; });
        for (const [k, v] of Object.entries(nav)) timings.push({ name: `${s.id}.${k}`, value: Math.round(v), unit: 'ms' });
      }
    } catch (e) { notCaptured.push(`${s.id} ${size.w}-${theme}: ${scrub(e.message).split('\n')[0]}`); }
    collect(rec);
    await context.close();
  }
}

// 3. Walk states from states.json.
const stateIds = [];
if (statesFile) {
  for (const st of JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8'))) {
    const { context, rec } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      for (const step of st.steps) await runStep(page, origin, step);
      await shot(page, path.join(out, 'screens', st.id), '1440-light');
      write(path.join(out, 'screens', st.id, 'render.html'), await page.content());
      write(path.join(out, 'screens', st.id, 'a11y.json'), { ariaSnapshot: await page.locator('body').ariaSnapshot() });
      stateIds.push(st.id);
    } catch (e) { notCaptured.push(`state ${st.id}: ${scrub(e.message).split('\n')[0]}`); }
    collect(rec);
    await context.close();
  }
}

// 4. Probes.
// A fresh context per call: it blocks the outside, records, and goto()s the screen's address.
const open = async (s, { width = 1440, height = 900, colorScheme = 'light' } = {}) => {
  const faults = {};
  const { context, rec } = await makeContext(browser, origin, { viewport: { width, height }, colorScheme, faults });
  const page = await context.newPage();
  return { page, rec, faults, close: () => context.close(), go: () => page.goto(new URL(s.url, origin).toString(), { waitUntil: 'load' }) };
};
const probes = await runProbes({ open, screens, timings });
const a11y = await measureScreens({ open, screens, timings, probes });
if (buildMs !== null) timings.push({ name: 'build-ms', value: buildMs, unit: 'ms' });
await browser.close();
stop();

let appVersion = run.appVersion || null;
if (!appVersion) try { appVersion = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8')).version || null; } catch {}
write(path.join(out, 'manifest.json'), {
  platform: 'web', appVersion, address: run.address,
  screens: screens.map(({ id, url, title }) => ({ id, url, title })),
  states: stateIds,
  blockedRequests: [...blocked].sort(),
  notCaptured,
});
let harBytes = 0;
const harKept = har.filter((e) => (harBytes += JSON.stringify(e).length) <= MAX_HAR_BYTES);
write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review web adapter', version: '1' }, entries: harKept } });
write(path.join(out, 'coverage.json'), {
  caps: { maxScreens: MAX_SCREENS, maxButtons: MAX_BUTTONS, maxHarBytes: MAX_HAR_BYTES },
  screensReached: screens.map((s) => s.url),
  screensCut: cutScreens,
  buttonsSkipped: skippedButtons,
  harEntriesSkipped: har.length - harKept.length,
});
write(path.join(out, 'timings.json'), timings);
write(path.join(out, 'probes.json'), probes);
write(path.join(out, 'a11y-violations.json'), a11y);
write(path.join(out, 'console.log'), consoleLines.join('\n') + (consoleLines.length ? '\n' : ''));
console.log(`captured ${screens.length} screens, ${stateIds.length} states, ${probes.filter((p) => !p.passed).length} probe flags -> ${out}`);
process.exit(0);

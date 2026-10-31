// Phase 2 checker: does the rebuild beat the original on every planted problem?
// node benchmark/score-rebuild.mjs <runDir> [--out file] [--control]
// Written from answers.json, but both sides are black boxes: controls are found by role and label, slow and failed
// requests are made here with page.route. Nothing is read from the app except its files (bloat).
// Results per item: present, gone, could not check. "could not check" never counts as beaten.
// --control: only the original is checked; exit 0 only if every item reads present on it.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../adapters/web/node_modules/playwright/index.mjs';
import { startApp } from '../adapters/web/app.mjs';

const PRESENT = 'present', GONE = 'gone', UNSURE = 'could not check';
const FLAG_MS = 16; // the keystroke probe's flag
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'H1', 'H2', 'H3', 'H4', 'B1', 'B2', 'B3', 'B4'];
const WHAT = {
  D1: 'script time per keystroke', D2: 'focus lost while typing in settings', D3: 'layout shift when the list loads',
  D4: 'stale search answer wins', D5: 'repeated requests after selecting a task', D6: 'no loading state',
  D7: 'failed save shows Saved', H1: 'key c focuses the new-task input', H2: 'padded title is stored trimmed',
  H3: 'Retry control after a failed list load', H4: '?density=compact changes the root class',
  B1: 'zustand dependency', B2: 'component imported nowhere', B3: 'legacy route', B4: 'moment dependency',
};
// What counts as the planted problem being beaten: gone for defects and bloat, present for hidden features.
const wanted = (id) => (id[0] === 'H' ? PRESENT : GONE);

const FEEDBACK = `(() => {
  const t = document.body.innerText;
  return !!document.querySelector('[aria-busy="true"],[role=progressbar],[role=status],progress,[class*=spinner i],[class*=loading i],[class*=skeleton i]')
    || /load|wait|spinner|fetching|please|saving|sending/i.test(t)
    || document.getAnimations().some((a) => a.playState === 'running');
})()`;
const SNAP = `(() => { window.__rects = new Map(); for (const e of document.body.querySelectorAll('*')) { const r = e.getBoundingClientRect(); window.__rects.set(e, [r.left, r.top]); } })()`;
const MOVED = `(() => {
  let d = 0;
  for (const [e, [x, y]] of window.__rects) {
    if (!e.isConnected) continue;
    const r = e.getBoundingClientRect();
    d = Math.max(d, Math.abs(r.top - y), Math.abs(r.left - x));
  }
  return d;
})()`;
const CLICKABLES = `(() => {
  const out = [], plain = [], named = [];
  let n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || ['INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer' && !['BUTTON', 'A'].includes(el.tagName) && el.getAttribute('role') !== 'button') continue;
    if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer' && !['BUTTON', 'A'].includes(el.tagName)) continue;
    const isBtn = ['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role') === 'button';
    el.setAttribute('data-sr-click', String(n));
    (isBtn ? named : plain).push({ i: n++, text: (el.innerText || '').trim().slice(0, 40) });
  }
  return plain.length ? plain.slice(0, 3) : named.filter((c) => !/add|save|retry|submit/i.test(c.text)).slice(0, 3);
})()`;

// ---- files: bloat ----
function walk(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '.git', '.next', 'coverage'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push(path.relative(base, p));
  }
  return acc;
}
const SRC = /\.(jsx?|tsx?|mjs|cjs|vue|svelte)$/;
export function bloat(source) {
  const out = {};
  const files = walk(source);
  const text = new Map(files.filter((f) => SRC.test(f)).map((f) => [f, fs.readFileSync(path.join(source, f), 'utf8')]));
  const pkgFile = path.join(source, 'package.json');
  const deps = fs.existsSync(pkgFile) ? readJson(pkgFile).dependencies || {} : {};
  out.B1 = deps.zustand ? [PRESENT, `zustand ${deps.zustand} in dependencies`] : [GONE, 'zustand not in dependencies'];
  out.B4 = deps.moment ? [PRESENT, `moment ${deps.moment} in dependencies`] : [GONE, 'moment not in dependencies'];
  const comps = [...text.keys()].filter((f) => f.split(path.sep).some((p) => /^components?$/i.test(p)));
  const unused = comps.filter((f) => {
    const stem = path.basename(f).replace(/\.\w+$/, '');
    if (stem === 'index') return false;
    const re = new RegExp(`['"][^'"]*/${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\w+)?['"]`);
    return ![...text].some(([g, t]) => g !== f && re.test(t));
  });
  out.B2 = unused.length ? [PRESENT, `imported nowhere: ${unused.join(', ')}`] : [GONE, `${comps.length} component file(s), each imported somewhere`];
  const legacy = [...text].filter(([, t]) => /['"`]\/legacy\b/.test(t)).map(([f]) => f);
  out.B3 = legacy.length ? [PRESENT, `route "/legacy" in ${legacy.join(', ')}`] : [GONE, 'no "/legacy" route in the source'];
  return out;
}

// ---- browser checks ----
// A fresh context; fetch/xhr go through `shape(request, count)` which returns { delay, status } to delay or fail them.
async function open(browser, origin, shape = () => ({})) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const seen = [];
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== origin) return route.abort('blockedbyclient');
    if (!['fetch', 'xhr'].includes(req.resourceType())) return route.fallback();
    seen.push(`${req.method()} ${req.url()}`);
    const s = shape(req, seen.length - 1) || {};
    if (s.delay) await sleep(s.delay);
    if (s.status) return route.fulfill({ status: s.status, contentType: 'application/json', body: '{"error":"simulated"}' });
    return route.fallback();
  });
  const page = await context.newPage();
  return { context, page, seen, go: (u = '/') => page.goto(new URL(u, origin).toString(), { waitUntil: 'domcontentloaded' }), settle: () => page.waitForLoadState('networkidle').catch(() => {}) };
}
const isGet = (r) => r.method() === 'GET';

async function searchBox(page) {
  for (const l of [page.getByRole('searchbox'), page.getByPlaceholder(/search/i), page.getByLabel(/search/i)]) {
    if (await l.count()) return l.first();
  }
  return null;
}
async function firstSettingsInput(page) {
  const h = page.getByRole('heading', { name: /settings/i }).first();
  if (!(await h.count())) return null;
  const f = h.locator('xpath=following::input[not(@type="hidden") and not(@type="checkbox") and not(@type="radio")][1]');
  return (await f.count()) ? f : null;
}

const checks = {
  async D2({ browser, origin }) {
    const t = await open(browser, origin);
    await t.go(); await t.settle();
    const f = await firstSettingsInput(t.page);
    if (!f) return [UNSURE, 'no text input found under a Settings heading'];
    const h = await f.elementHandle();
    await f.click();
    await t.page.keyboard.type('x');
    await sleep(150);
    const kept = await t.page.evaluate((el) => el.isConnected && document.activeElement === el, h);
    await t.context.close();
    return [kept ? GONE : PRESENT, kept ? 'focus stayed in the first settings input after one character' : 'focus left the first settings input after one character'];
  },
  async D3({ browser, origin }) {
    const t = await open(browser, origin, (r) => (isGet(r) ? { delay: 1500 } : {}));
    await t.go();
    await sleep(300);
    await t.page.evaluate(SNAP);
    await sleep(2200);
    const d = await t.page.evaluate(MOVED);
    const n = t.seen.length;
    await t.context.close();
    if (!n) return [UNSURE, 'no request was made on load, nothing was delayed'];
    return [d > 10 ? PRESENT : GONE, `an element present before the answer moved ${Math.round(d)} px (limit 10)`];
  },
  async D4({ browser, origin }) {
    const text = async (steps) => {
      const t = await open(browser, origin);
      await t.go(); await t.settle();
      const box = await searchBox(t.page);
      if (!box) { await t.context.close(); return null; }
      await box.click();
      for (const c of steps) { await t.page.keyboard.type(c); await sleep(2000); }
      const s = norm(await t.page.innerText('body'));
      await t.context.close();
      return s;
    };
    const a = await text(['a']);
    if (a === null) return [UNSURE, 'no search box found by role, placeholder or label'];
    const b = await text(['a', 'b']);
    if (a === b) return [UNSURE, 'the page reads the same for "a" and "ab", cannot tell which answer is shown'];
    let armed = false, k = 0;
    const t = await open(browser, origin, (r) => (armed && isGet(r) ? { delay: k++ === 0 ? 1500 : 100 } : {}));
    await t.go(); await t.settle();
    const box = await searchBox(t.page);
    await box.click();
    armed = true;
    await t.page.keyboard.type('ab', { delay: 0 });
    await sleep(3000);
    const end = norm(await t.page.innerText('body'));
    await t.context.close();
    if (k < 2) return [UNSURE, `only ${k} search request(s) were made for two keystrokes`];
    if (end === a) return [PRESENT, 'after "ab" the page shows the answer for "a" (first answer arrived last)'];
    if (end === b) return [GONE, 'after "ab" the page shows the answer for "ab" although the first answer arrived last'];
    return [UNSURE, 'the final page matches neither the "a" nor the "ab" reading'];
  },
  async D5({ browser, origin }) {
    const probe = await open(browser, origin);
    await probe.go(); await probe.settle();
    const found = await probe.page.evaluate(CLICKABLES);
    await probe.context.close();
    if (!found.length) return [UNSURE, 'nothing to select was found'];
    let worst = 0, worstUrl = '';
    for (let i = 0; i < found.length; i++) {
      const t = await open(browser, origin);
      await t.go(); await t.settle();
      await t.page.evaluate(CLICKABLES);
      t.seen.length = 0;
      try { await t.page.locator(`[data-sr-click="${found[i].i}"]`).first().click({ timeout: 2000 }); } catch { await t.context.close(); continue; }
      await sleep(3000);
      const counts = {};
      for (const k of t.seen) counts[k] = (counts[k] || 0) + 1;
      const [k, c] = Object.entries(counts).sort((x, y) => y[1] - x[1])[0] || ['', 0];
      if (c > worst) { worst = c; worstUrl = k; }
      await t.context.close();
    }
    return [worst >= 3 ? PRESENT : GONE, `most repeated request in 3 s after a click: ${worst}x${worstUrl ? ' ' + worstUrl.replace(/^(\S+) https?:\/\/[^/]+/, '$1 ') : ''} (limit 3)`];
  },
  async D6({ browser, origin }) {
    const t = await open(browser, origin, (r) => (isGet(r) ? { delay: 1500 } : {}));
    await t.go();
    await sleep(60);
    const first = norm(await t.page.innerText('body'));
    await sleep(440);
    const later = norm(await t.page.innerText('body'));
    const fb = await t.page.evaluate(FEEDBACK);
    const n = t.seen.length;
    await t.context.close();
    if (!n) return [UNSURE, 'no request was made on load, nothing was delayed'];
    const shown = fb || first !== later;
    return [shown ? GONE : PRESENT, shown ? 'something is shown at 500 ms while the list request is pending' : 'at 500 ms the page has no rows, progress role, busy state or loading text'];
  },
  async D7({ browser, origin }) {
    let fail = false;
    const t = await open(browser, origin, (r) => (fail && !isGet(r) ? { status: 500 } : {}));
    await t.go(); await t.settle();
    const save = t.page.getByRole('button', { name: /save/i }).first();
    if (!(await save.count())) return [UNSURE, 'no Save button found by role and name'];
    fail = true;
    t.seen.length = 0;
    await save.click();
    await sleep(1200);
    const body = await t.page.innerText('body');
    const alert = await t.page.locator('[role=alert]').count();
    const wrote = t.seen.some((s) => !s.startsWith('GET '));
    await t.context.close();
    if (!wrote) return [UNSURE, 'clicking Save sent no write request'];
    const said = /\bsaved\b/i.test(body), err = alert > 0 || /error|fail|couldn.?t|could not|unable|went wrong|try again/i.test(body);
    return [said && !err ? PRESENT : GONE, said ? (err ? 'Saved shows, and so does an error' : 'Saved shows after the save answered 500, with no alert or error text') : 'no "Saved" text after the save answered 500'];
  },
  // D1: the list is multiplied to 2000 rows with page.route, then script time per keystroke in the search box is
  // measured the way the script-cost-per-key probe does (4x CPU slowdown, 100 ms between keys).
  async D1({ browser, origin }) {
    const N = 2000;
    let template = null, replaced = 0;
    const listOf = (j) => {
      const isRows = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (isRows(j)) return { rows: j, put: (rows) => rows };
      if (j && typeof j === 'object') {
        const k = Object.keys(j).find((key) => isRows(j[key]));
        if (k) return { rows: j[k], put: (rows) => ({ ...j, [k]: rows }) };
      }
      return null;
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (new URL(req.url()).origin !== origin) return route.abort('blockedbyclient');
      if (!['fetch', 'xhr'].includes(req.resourceType()) || req.method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      let body = null;
      try { body = await res.json(); } catch { return route.fulfill({ response: res }); }
      const l = listOf(body);
      if (!l) return route.fulfill({ response: res });
      template = template || l.rows[0];
      const rows = Array.from({ length: N }, (_, i) => {
        const copy = { ...template };
        for (const key of Object.keys(copy)) if (/^_?id$/i.test(key)) copy[key] = typeof copy[key] === 'number' ? 1000000 + i : `${copy[key]}-${i}`;
        return copy;
      });
      replaced++;
      return route.fulfill({ response: res, json: l.put(rows) });
    });
    const page = await context.newPage();
    await page.goto(new URL('/', origin).toString(), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(500);
    const done = async (r) => { await context.close(); return r; };
    if (!template) return done([UNSURE, 'no JSON list response was found to multiply']);
    const box = await searchBox(page);
    if (!box) return done([UNSURE, 'no search box found by role, placeholder or label']);
    const title = String(template.title ?? template.name ?? Object.values(template).find((v) => typeof v === 'string') ?? '');
    const letter = title.trim()[0];
    if (!letter) return done([UNSURE, 'the first list entry has no title text']);
    const countRows = () => page.evaluate((t) => {
      let n = 0;
      for (const e of document.body.querySelectorAll('*')) if (e.textContent.includes(t) && ![...e.children].some((c) => c.textContent.includes(t))) n++;
      return n;
    }, title);
    const rowsBefore = await countRows();
    if (rowsBefore < N) return done([UNSURE, `only ${rowsBefore} row(s) rendered, fewer than ${N}`]);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const script = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'ScriptDuration').value;
    await box.click();
    let typed = '', total = 0;
    for (let k = 0; k < 5; k++) {
      if (!title.toLowerCase().includes((typed + letter).toLowerCase())) {
        await box.fill('');
        typed = '';
        await sleep(600);
      }
      const before = await script();
      await page.keyboard.type(letter);
      typed += letter;
      await sleep(100);
      total += (await script()) - before;
    }
    await sleep(800);
    const rowsAfter = await countRows();
    const ms = Math.round((total * 1000 / 5) * 10) / 10;
    if (rowsAfter < N) return done([UNSURE, `only ${rowsAfter} row(s) rendered after typing "${typed}", fewer than ${N}`]);
    const r = await done([ms > FLAG_MS ? PRESENT : GONE, `${ms} ms of script per keystroke at 4x CPU slowdown with ${rowsAfter} rows rendered (flag above ${FLAG_MS})`]);
    r.ms = ms; r.rows = rowsAfter;
    return r;
  },
  async H1({ browser, origin }) {
    const t = await open(browser, origin);
    await t.go(); await t.settle();
    await t.page.evaluate(() => document.activeElement && document.activeElement.blur());
    await t.page.keyboard.press('c');
    const a = await t.page.evaluate(() => { const e = document.activeElement; return { tag: e.tagName, label: [e.id, e.placeholder, e.getAttribute('aria-label')].join(' ') }; });
    await t.context.close();
    const ok = ['INPUT', 'TEXTAREA'].includes(a.tag) && !/search|filter/i.test(a.label);
    return [ok ? PRESENT : GONE, ok ? `pressing c focused an input (${norm(a.label) || 'unnamed'})` : `pressing c left focus on ${a.tag}`];
  },
  async H2({ browser, origin }) {
    const t = await open(browser, origin);
    await t.go(); await t.settle();
    const inputs = t.page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea');
    let field = null;
    for (let i = 0, n = await inputs.count(); i < n && !field; i++) {
      const f = inputs.nth(i);
      const label = await f.evaluate((e) => [e.id, e.name, e.placeholder, e.getAttribute('aria-label')].join(' '));
      if ((await f.isVisible()) && !/search|filter/i.test(label)) field = f;
    }
    if (!field) return [UNSURE, 'no new-task input found'];
    const bodies = [];
    t.page.on('request', (r) => { if (['fetch', 'xhr'].includes(r.resourceType()) && r.method() !== 'GET') bodies.push(r.postData() || ''); });
    await field.fill('  padded  ');
    await field.press('Enter');
    await sleep(800);
    await t.context.close();
    const sent = bodies.find((b) => b.includes('padded'));
    if (!sent) return [UNSURE, 'submitting the title sent no write request containing it'];
    const m = sent.match(/(.)padded(.)/s);
    const trimmed = m && !/\s/.test(m[1]) && !/\s/.test(m[2]);
    return [trimmed ? PRESENT : GONE, trimmed ? 'the request carries "padded" without the spaces around it' : 'the request carries the spaces around "padded"'];
  },
  async H3({ browser, origin }) {
    const t = await open(browser, origin, (r) => (isGet(r) ? { status: 500 } : {}));
    await t.go();
    await sleep(1500);
    const retry = await t.page.getByRole('button', { name: /retry/i }).or(t.page.getByRole('link', { name: /retry/i })).count();
    await t.context.close();
    return [retry ? PRESENT : GONE, retry ? 'a Retry control shows after the list request failed' : 'no Retry control after the list request failed'];
  },
  async H4({ browser, origin }) {
    const classes = async (u) => {
      const t = await open(browser, origin);
      await t.go(u); await t.settle();
      const c = await t.page.evaluate(() => [...document.querySelectorAll('html, body, body *')].flatMap((e) => (typeof e.className === 'string' ? e.className.split(/\s+/) : [])).filter((c) => /compact/i.test(c)));
      await t.context.close();
      return c;
    };
    const plain = await classes('/'), compact = await classes('/?density=compact');
    const ok = compact.length > 0 && plain.length === 0;
    return [ok ? PRESENT : GONE, ok ? `?density=compact adds class "${compact[0]}"` : `?density=compact adds no class containing "compact" (${compact.length} with, ${plain.length} without)`];
  },
};

export async function checkSide({ browser, origin, source }) {
  const res = {};
  for (const id of Object.keys(checks)) {
    try { const r = await checks[id]({ browser, origin }); res[id] = { state: r[0], evidence: r[1], ms: r.ms }; }
    catch (e) { res[id] = { state: UNSURE, evidence: String(e.message).split('\n')[0] }; }
  }
  for (const [id, [state, evidence]] of Object.entries(bloat(source))) res[id] = { state, evidence };
  return res;
}

// ---- main ----
async function side(runFile, only) {
  const run = readJson(runFile);
  const app = await startApp(run, runFile);
  const browser = await chromium.launch();
  try { return await checkSide({ browser, origin: app.origin, source: app.workDir }); }
  finally { await browser.close(); app.stop(); await sleep(300); }
}

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const runDir = path.resolve(process.argv[2] || '');
  const control = process.argv.includes('--control');
  const out = arg('out');
  const orig = await side(path.join(runDir, 'run.json'));
  const reb = control ? null : await side(path.join(runDir, 'project', 'rebuild-run.json'));
  // D1 compares the two readings taken under the same 2000-row load. An original at or under the flag cannot show the
  // problem, so D1 is "could not check" on both sides; nothing is changed to get a pass.
  const o = orig.D1.ms;
  if (orig.D1.state !== UNSURE && !(o > FLAG_MS)) orig.D1 = { state: UNSURE, evidence: `original reads ${orig.D1.ms} ms per key under the load, not above ${FLAG_MS}: the check cannot see the problem. ${orig.D1.evidence}` };
  if (reb) {
    const r = reb.D1.ms;
    if (orig.D1.state === UNSURE) reb.D1 = { state: UNSURE, evidence: `not judged: the original reading is unusable. rebuild: ${reb.D1.evidence}` };
    else if (reb.D1.state !== UNSURE) {
      const lower = r <= FLAG_MS || r <= o / 2;
      reb.D1 = { state: lower ? GONE : PRESENT, evidence: `${r} ms per key against ${o} on the original under the same load, ${reb.D1.evidence.match(/with (\d+) rows/)[1]} rows on the rebuild (gone at or under ${FLAG_MS} ms or at least 50% lower)` };
    }
  }
  const rows = IDS.map((id) => ({ id, what: WHAT[id], original: orig[id], rebuild: reb ? reb[id] : null }));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('item', 5)}${pad('original', 17)}${pad('rebuild', 17)}evidence`);
  for (const r2 of rows) console.log(`${pad(r2.id, 5)}${pad(r2.original.state, 17)}${pad(r2.rebuild ? r2.rebuild.state : '-', 17)}${r2.what}. original: ${r2.original.evidence}${r2.rebuild ? `. rebuild: ${r2.rebuild.evidence}` : ''}`);
  const hasAll = rows.every((r2) => r2.original.state === PRESENT);
  const beaten = reb ? rows.every((r2) => r2.rebuild.state === wanted(r2.id)) : null;
  console.log(`original has every item: ${hasAll ? 'yes' : 'NO: ' + rows.filter((r2) => r2.original.state !== PRESENT).map((r2) => r2.id).join(' ')}`);
  if (reb) console.log(`rebuild beats every item: ${beaten ? 'yes' : 'NO: ' + rows.filter((r2) => r2.rebuild.state !== wanted(r2.id)).map((r2) => `${r2.id} (${r2.rebuild.state})`).join(' ')}`);
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ rows, originalHasEvery: hasAll, rebuildBeatsEvery: beaten }, null, 2));
  process.exit(hasAll && (control || beaten) ? 0 : 1);
}

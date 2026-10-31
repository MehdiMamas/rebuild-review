// Electron capture adapter. node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json] [--max-screens N] [--max-buttons N] [--max-har-bytes N]
// run.json: { platform: "electron", dir?, install?, build?, launch: { executablePath?, args?, schemes? } }
// A screen is (window title kind, signature of its accessibility snapshot). Screens have no addresses, so each is
// reached by clicking from a window that was open at start, and reached again by relaunching and replaying its steps.
import fs from 'node:fs';
import path from 'node:path';
import { scrub, sleep } from '../web/context.mjs';
import { runProbes } from '../web/probes.mjs';
import { measureScreens } from '../web/metrics.mjs';
import { launchApp, replay, kindOf, signature, electronOpener, prepareApp, SIZES } from './launch.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const out = path.resolve(arg('out') || '');
const statesFile = arg('states');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'electron') throw new Error(`electron adapter cannot capture platform "${run.platform}"`);
const MAX_SCREENS = Number(arg('max-screens')) || 30;
const MAX_BUTTONS = Number(arg('max-buttons')) || 10;
const MAX_HAR_BYTES = Number(arg('max-har-bytes')) || 50 * 1024 * 1024;
const CONTROLS = 'button, [role=button], [role=tab], [role=menuitem], [role=treeitem], [role=link]';
const { workDir, buildMs } = prepareApp(run, appFile);
process.env.RR_PREPARED = '1';
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(1)); // the exit handler in launch.mjs kills the app

const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const har = [], consoleLines = [], blocked = new Set(), timings = [], dialogs = [], notCaptured = [];
const cutScreens = [], skippedButtons = [];
let launchMs = null;

async function launch(label, steps = [], theme = 'light') {
  const t = Date.now();
  const s = await launchApp(run, appFile, { theme });
  if (launchMs === null) launchMs = Date.now() - t;
  s.label = label;
  await sleep(500); // let windows the app opens at start appear
  await replay(s, steps);
  return s;
}
async function finish(s) {
  har.push(...s.rec.har);
  consoleLines.push(...s.rec.console.map((m) => `error ${m}`), ...s.rec.pageErrors.map((m) => `pageerror ${m}`), ...s.rec.main.map((m) => `main ${m}`));
  s.rec.blocked.forEach((b) => blocked.add(b));
  for (const d of await s.dialogs()) dialogs.push({ ...d, screen: s.label });
  await s.stop();
}
async function describe(page) {
  const title = await page.title().catch(() => '');
  const heading = await page.locator('h1, h2, [role=heading]').first().innerText({ timeout: 500 }).catch(() => '');
  return { kind: kindOf(title), title, heading: heading.trim().replace(/\s+/g, ' '), sig: await signature(page) };
}

// 1. Crawl. Breadth first: every control on a screen is tried; a new identity is a new screen with the steps that reach it.
const screens = [], known = new Set(), queue = [];
function register(d, steps, from) {
  const key = `${d.kind}|${d.sig}`;
  if (known.has(key)) return false;
  if (screens.length >= MAX_SCREENS) {
    known.add(key);
    cutScreens.push(`${d.kind}: ${d.heading || d.sig}`);
    return false;
  }
  known.add(key);
  const s = { ...d, steps, openedFrom: from, id: '' };
  screens.push(s); queue.push(s);
  return true;
}
{
  const s0 = await launch('crawl');
  await sleep(500);
  for (const w of [...s0.windows]) register(await describe(w), [{ open: kindOf(await w.title()) }], null);
  await finish(s0);
}
for (let qi = 0; qi < queue.length; qi++) {
  const screen = queue[qi];
  let s = await launch(`crawl ${screen.kind}: ${screen.heading}`, screen.steps);
  const names = await s.page.locator(CONTROLS).evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && !e.disabled; })
    .map((e) => (e.getAttribute('aria-label') || e.innerText || e.title || e.value || '').trim().replace(/\s+/g, ' ')));
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length > MAX_BUTTONS) {
    notCaptured.push(`${screen.kind}: ${screen.heading || screen.sig}: only the first ${MAX_BUTTONS} of ${unique.length} controls were tried`);
    skippedButtons.push({ screen: `${screen.kind}: ${screen.heading || screen.sig}`, tried: MAX_BUTTONS, skipped: unique.length - MAX_BUTTONS });
  }
  for (const name of unique.slice(0, MAX_BUTTONS)) {
    const before = new Set(s.windows);
    try { await replay(s, [{ click: name }], 500); } catch (e) { notCaptured.push(`${screen.heading || screen.kind}: control "${name}": ${scrub(e.message).split('\n')[0]}`); continue; }
    const base = [...screen.steps, { click: name }];
    for (const w of s.windows.filter((x) => !before.has(x))) {
      try { register(await describe(w), [...base, { open: kindOf(await w.title()) }], screen.id || `${screen.kind}: ${screen.heading}`); } catch {}
      await w.close().catch(() => {});
    }
    let changed = false;
    if (!s.page.isClosed()) {
      const d = await describe(s.page).catch(() => null);
      if (d && `${d.kind}|${d.sig}` !== `${screen.kind}|${screen.sig}`) { changed = true; register(d, base, `${screen.kind}: ${screen.heading}`); }
    } else changed = true;
    if (changed) { await finish(s); s = await launch(`crawl ${screen.kind}: ${screen.heading}`, screen.steps); }
  }
  await finish(s);
}
if (cutScreens.length) notCaptured.push(`crawl stopped at ${MAX_SCREENS} screens; ${cutScreens.length} more found and not captured`);
// ids: the heading when there is one, else window and signature; unique.
const ids = new Set();
for (const s of screens) { let id = slug(s.heading) || `${slug(s.kind)}-${s.sig}`, n = 2; const base = id; while (ids.has(id)) id = `${base}-${n++}`; s.id = id; ids.add(id); }
for (const s of screens) if (s.openedFrom && !ids.has(s.openedFrom)) { const f = screens.find((x) => `${x.kind}: ${x.heading}` === s.openedFrom); s.openedFrom = f ? f.id : s.openedFrom; }

// 2. Capture every screen at both sizes and themes.
const shotBuf = async (page) => page.screenshot();
for (const s of screens) {
  const dir = path.join(out, 'screens', s.id);
  let sess;
  try {
    sess = await launch(`capture ${s.id}`, s.steps);
    const page = sess.page;
    fs.mkdirSync(dir, { recursive: true });
    for (const size of [SIZES.narrow, SIZES.wide]) {
      const got = await sess.setSize(page, size.w, size.h).catch(() => null);
      if (!got || Math.abs(got[0] - size.w) > 2 || Math.abs(got[1] - size.h) > 2) notCaptured.push(`${s.id} ${size.w}: the window kept a content size of ${got ? got.join('x') : 'unknown'} instead of ${size.w}x${size.h}`);
      const bufs = {};
      for (const theme of ['light', 'dark']) {
        await sess.setTheme(theme);
        await sleep(300);
        bufs[theme] = await shotBuf(page);
        fs.writeFileSync(path.join(dir, `${size.w}-${theme}.png`), bufs[theme]);
      }
      if (bufs.light.equals(bufs.dark)) notCaptured.push(`${s.id} ${size.w}: theme did not change (the light and dark screenshots are identical)`);
      if (size === SIZES.wide) {
        await sess.setTheme('light'); await sleep(200);
        write(path.join(dir, 'render.html'), await page.content());
        write(path.join(dir, 'render.css.json'), await page.evaluate(() => [...document.body.querySelectorAll('*')].slice(0, 3000).map((e) => {
          const c = getComputedStyle(e), r = e.getBoundingClientRect();
          const p = {}; for (const k of ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'margin', 'padding', 'border', 'gap']) p[k] = c.getPropertyValue(k);
          return { tag: e.tagName.toLowerCase(), id: e.id || undefined, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], style: p };
        })));
        write(path.join(dir, 'a11y.json'), { ariaSnapshot: await page.locator('body').ariaSnapshot() });
      }
    }
  } catch (e) { notCaptured.push(`${s.id}: ${scrub(e.message).split('\n')[0]}`); }
  if (sess) await finish(sess);
}

// 3. Walk states from states.json. { open } names a window kind.
const stateIds = [];
if (statesFile) {
  for (const st of JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8'))) {
    let sess;
    try {
      sess = await launch(`state ${st.id}`, st.steps);
      await sess.setSize(sess.page, SIZES.wide.w, SIZES.wide.h).catch(() => {});
      const dir = path.join(out, 'screens', st.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${SIZES.wide.w}-light.png`), await sess.page.screenshot());
      write(path.join(dir, 'render.html'), await sess.page.content());
      write(path.join(dir, 'a11y.json'), { ariaSnapshot: await sess.page.locator('body').ariaSnapshot() });
      stateIds.push(st.id);
    } catch (e) { notCaptured.push(`state ${st.id}: ${scrub(e.message).split('\n')[0]}`); }
    if (sess) await finish(sess);
  }
}

// 4. Probes and measurements, each on a fresh isolated launch of the screen.
const open = electronOpener(run, appFile);
const widths = [SIZES.narrow.w, SIZES.wide.w];
const probes = await runProbes({ open, screens, timings, widths });
const a11y = await measureScreens({ open, screens, timings, probes, widths });
if (buildMs !== null) timings.push({ name: 'build-ms', value: buildMs, unit: 'ms' });
if (launchMs !== null) timings.push({ name: 'launch-ms', value: launchMs, unit: 'ms' });

notCaptured.push('requests made by the main process are not observed (only the renderer is); they are sent to a dead proxy so they cannot leave the machine');
notCaptured.push('the profile is isolated and empty: anything behind a sign-in is not reached');
let appVersion = run.appVersion || null;
if (!appVersion) try { appVersion = JSON.parse(fs.readFileSync(path.join(workDir, 'package.json'), 'utf8')).version || null; } catch {}
write(path.join(out, 'manifest.json'), {
  platform: 'electron', appVersion,
  screens: screens.map(({ id, kind, title, heading, steps, openedFrom }) => ({ id, window: kind, title, heading, steps, openedFrom })),
  states: stateIds,
  blockedRequests: [...blocked].sort(),
  nativeDialogs: dialogs,
  notCaptured,
});
let harBytes = 0;
const harKept = har.filter((e) => (harBytes += JSON.stringify(e).length) <= MAX_HAR_BYTES);
write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review electron adapter', version: '1' }, entries: harKept } });
write(path.join(out, 'coverage.json'), {
  caps: { maxScreens: MAX_SCREENS, maxButtons: MAX_BUTTONS, maxHarBytes: MAX_HAR_BYTES },
  screensReached: screens.map((s) => s.id),
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

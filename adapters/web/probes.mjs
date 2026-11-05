// Interaction probes. Each is a general check for one kind of failure; none knows the app.
// Result rows: { probe, screen, passed, evidence }. passed=false means the probe flagged a problem.
import { makeContext, sleep, isDataRequest } from './context.mjs';

const TYPE_TEXT = 'xyz';
const FEEDBACK = `(() => {
  const t = document.body.innerText;
  return !!document.querySelector('[aria-busy="true"],[role=progressbar],[role=status],progress,[class*=spinner i],[class*=loading i],[class*=skeleton i]')
    || /load|wait|spinner|fetching|please|saving|sending/i.test(t)
    || document.getAnimations().some((a) => a.playState === 'running');
})()`;
const ERRORISH = `(() => {
  const t = document.body.innerText;
  return document.querySelectorAll('[role=alert]').length + (t.match(/error|fail|couldn.?t|could not|unable|went wrong|try again|retry/gi) || []).length;
})()`;
const tagClickables = (max) => `(() => {
  const seen = new Set(); let n = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('[data-rr-click]')) continue;
    const cs = getComputedStyle(el);
    const clickable = ['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role') === 'button' || cs.cursor === 'pointer';
    if (!clickable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    if (cs.cursor === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') continue; // inherited
    const sig = el.tagName + '.' + el.className + (['BUTTON', 'A'].includes(el.tagName) ? ':' + el.innerText : '');
    if (seen.has(sig)) continue;
    seen.add(sig); el.setAttribute('data-rr-click', String(n++));
    if (n >= ${max}) break;
  }
  return [...document.querySelectorAll('[data-rr-click]')].map((e) => (e.innerText || e.tagName).trim().slice(0, 30));
})()`;
// Only elements the user can see are recorded: a hidden part (display none, visibility hidden or
// opacity 0 on it or an ancestor, or an empty box) that moves before it is shown is no shift (#86).
export const SNAP = `(() => {
  window.__rects = new Map();
  const seen = (e, r) => {
    if (!r.width && !r.height) return false;
    if (e.checkVisibility) return e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    return getComputedStyle(e).visibility !== 'hidden' && e.getClientRects().length > 0;
  };
  for (const e of document.body.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (seen(e, r)) window.__rects.set(e, [r.left, r.top]); }
})()`;
export const MOVED = `(() => {
  let worst = { d: 0 };
  for (const [e, [x, y]] of window.__rects) {
    if (!e.isConnected) continue;
    const r = e.getBoundingClientRect(), d = Math.max(Math.abs(r.top - y), Math.abs(r.left - x));
    if (d > worst.d) worst = { d, el: e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') };
  }
  return worst;
})()`;
const WATCH = `(() => {
  if (window.__ls !== undefined) return;
  window.__ls = 0; window.__maxEvt = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__ls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__maxEvt = Math.max(window.__maxEvt, e.duration); }).observe({ type: 'event', durationThreshold: 16, buffered: true });
})()`;

// A screen of the web adapter is a URL in a fresh browser context. Another adapter passes openScreen(screen, { width, height })
// instead, which returns { page, rec, faults, close, go }: go() reaches the screen (a window, a route, a page of the app).
async function open(c, s, opts = {}) {
  let faults = {}, context, rec, page, go, ctxEvents;
  if (c.openScreen) {
    const vp = opts.viewport;
    const t = await c.openScreen(s, vp ? { width: vp.width, height: vp.height } : {});
    page = t.page; rec = t.rec; faults = t.faults; go = async () => { await t.go(); await page.evaluate(WATCH); };
    // The probes watch requests on the whole context, so they also see a screen that lives in another window.
    context = { newCDPSession: () => t.page.context().newCDPSession(t.page), close: t.close };
    opts.track?.add(context);
    page = new Proxy({}, { get: (_, k) => { const cur = t.page; const v = cur[k]; return typeof v === 'function' ? v.bind(cur) : v; } });
    ctxEvents = t.page.context();
  } else {
    const url = new URL(s.url, c.origin).toString();
    ({ context, rec } = await makeContext(c.browser, c.origin, { viewport: { width: 1440, height: 900 }, ...opts, faults }));
    opts.track?.add(context);
    page = await context.newPage();
    await page.addInitScript(WATCH);
    go = () => page.goto(url, { waitUntil: 'load' });
    ctxEvents = page;
  }
  const api = { pending: 0, seen: [] };
  ctxEvents.on('request', (r) => {
    if (isDataRequest(r)) { api.pending++; api.seen.push(`${r.method()} ${r.url()}`); }
  });
  const done = (r) => isDataRequest(r) && api.pending--;
  ctxEvents.on('requestfinished', done);
  ctxEvents.on('requestfailed', done);
  return { context, rec, page, faults, api, go };
}

// Options shared by loadProbes, clickProbes and runProbes (all optional; the defaults are what capture uses):
//   storageState, allowOrigins, onBlocked   passed to makeContext
//   ignoreBlocked   console errors caused by a blocked cross-origin request are not flagged
//   deadline        ms timestamp; what has not started by then goes to notChecked ({probe, route, reason})
//   maxClickables (10), labelFilter(label) => false skips a click (listed in skipped: [{route, label}]),
//   idleMs caps each networkidle wait, timeout / navTimeout set the context defaults (absent: Playwright's)
//   concurrency (1) for click probes, noClicks: reason string, no click runs and each is notChecked
const BLOCKED = /ERR_BLOCKED_BY_CLIENT/;

function setup(o) {
  const env = { storageState: o.storageState, allowOrigins: o.allowOrigins, onBlocked: o.onBlocked, timeout: o.timeout, navTimeout: o.navTimeout };
  return { ...o, env, maxClickables: o.maxClickables ?? 10, concurrency: o.concurrency ?? 1, state: { worstMs: null } };
}

// networkidle wait; idleMs (check only) caps it, since a polling app never goes idle.
const idle = (c, page) => page.waitForLoadState('networkidle', c.idleMs ? { timeout: c.idleMs } : undefined).catch(() => {});

// A page or window that closed under a probe (a click that closes the window or reloads the app into a new one) is not a failure of the app.
export const closedReason = (e) => (/Target page, context or browser has been closed|Target closed/.test(String(e && e.message)) ? 'the window closed or reloaded after the click' : null);

// Runs one probe group. A throw closes the group's contexts; with c.notChecked it becomes notChecked rows, else it is rethrown.
async function guard(c, s, probes, what, fn) {
  const live = new Set();
  try { await fn({ ...c.env, track: live }); }
  catch (e) {
    if (!c.notChecked) throw e;
    for (const probe of probes) c.notChecked.push({ probe, route: s.url || s.id, reason: `${what}${closedReason(e) || String(e.message).split('\n')[0]}` });
  } finally { for (const x of live) await x.close().catch(() => {}); }
}

const late = (c, s, probes, what = '') => {
  if (!c.deadline || Date.now() <= c.deadline) return false;
  for (const probe of probes) c.notChecked?.push({ probe, route: s.url || s.id, reason: `${what}time budget used up` });
  return true;
};

async function loadScreen(c, s, add) {

  // Console errors, plain load; also focus-lost and input delay while typing into every text field.
  if (!late(c, s, ['console-errors', 'focus-lost', 'input-delay'])) await guard(c, s, ['console-errors', 'focus-lost', 'input-delay'], '', async (env) => {
    const t = await open(c, s, env);
    const cdp = await t.context.newCDPSession(t.page);
    await t.go();
    await idle(c, t.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const errs = [...t.rec.console, ...t.rec.pageErrors].filter((e) => !(c.ignoreBlocked && BLOCKED.test(e)));
    add('console-errors', s.id, errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'none');
    const fields = t.page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea');
    const count = await fields.count();
    const lost = [];
    let worst = 0, worstField = '';
    for (let i = 0; i < count; i++) {
      const f = fields.nth(i);
      if (!(await f.isVisible())) continue;
      const label = (await f.evaluate((e) => e.id || e.name || e.placeholder || e.tagName)) || 'field';
      const h = await f.elementHandle();
      await f.click();
      await t.page.evaluate(() => { window.__maxEvt = 0; });
      for (const ch of TYPE_TEXT) {
        await t.page.keyboard.type(ch);
        await sleep(60);
        if (!(await t.page.evaluate((el) => el.isConnected && document.activeElement === el, h))) {
          lost.push(`${label} after "${ch}": focus is now ${await t.page.evaluate(() => document.activeElement.tagName)}`);
          break;
        }
      }
      await sleep(100);
      const evt = await t.page.evaluate(() => window.__maxEvt);
      if (evt > worst) { worst = evt; worstField = label; }
    }
    add('focus-lost', s.id, lost.length === 0, lost.length ? lost.join('; ') : `${count} field(s) kept focus while typing`);
    add('input-delay', s.id, worst < 50, `slowest input event ${Math.round(worst)} ms at 4x CPU slowdown${worstField ? ` in ${worstField}` : ''}; budget 50 ms`, { value: Math.round(worst), unit: 'ms' });
    await t.context.close();
  });

  // Script time per keystroke: every visible text input (up to 5), each on a fresh page, CPU 4x slower,
  // 5 characters 100 ms apart. Budget one frame (16 ms).
  if (!late(c, s, ['script-cost-per-key'])) await guard(c, s, ['script-cost-per-key'], '', async (env) => {
    const SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea';
    const visible = [];
    {
      const t = await open(c, s, env);
      await t.go();
      await idle(c, t.page);
      const all = t.page.locator(SEL);
      for (let i = 0, n = await all.count(); i < n && visible.length < 5; i++) if (await all.nth(i).isVisible()) visible.push(i);
      await t.context.close();
    }
    for (const i of visible) {
      if (late(c, s, ['script-cost-per-key'])) break;
      const t = await open(c, s, env);
      await t.go();
      await idle(c, t.page);
      const field = t.page.locator(SEL).nth(i);
      const label = (await field.evaluate((e) => e.id || e.name || e.placeholder || e.tagName)) || 'field';
      const cdp = await t.context.newCDPSession(t.page);
      await cdp.send('Performance.enable');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const script = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'ScriptDuration').value;
      await field.click();
      const before = await script();
      for (const ch of 'abcde') { await t.page.keyboard.type(ch); await sleep(100); }
      const ms = ((await script()) - before) * 1000 / 5;
      c.state.worstMs = Math.max(c.state.worstMs ?? 0, ms);
      add('script-cost-per-key', `${s.id}:${label}`, ms <= 16, `${ms.toFixed(1)} ms of script per keystroke at 4x CPU slowdown in ${label}; budget 16 ms`, { value: Number(ms.toFixed(1)), unit: 'ms' });
      await t.context.close();
    }
  });

  // Layout shift on load, both sizes, with and without slow API answers. Two signals: the browser's
  // layout-shift entries, and any element present early that later moved 8 px or more (an empty
  // container the content later pushes down produces no entry, but is a shift all the same).
  if (!late(c, s, ['layout-shift'])) await guard(c, s, ['layout-shift'], '', async (env) => {
    for (const width of c.widths || [390, 1440]) {
      for (const slowMs of [0, 1500]) {
        const t = await open(c, s, { ...env, viewport: { width, height: 900 } });
        t.faults.slowMs = slowMs;
        await t.go();
        await t.page.evaluate(SNAP);
        await sleep(slowMs + 1200);
        const ls = await t.page.evaluate(() => window.__ls);
        const mv = await t.page.evaluate(MOVED);
        add('layout-shift', `${s.id}@${width}${slowMs ? '-slow' : ''}`, ls < 0.05 && mv.d < 8, `cumulative shift ${ls.toFixed(3)} (limit 0.05); largest move of an early element ${Math.round(mv.d)} px${mv.el ? ` (${mv.el})` : ''} (limit 8)`);
        await t.context.close();
      }
    }
  });

  // No visible feedback while the page's own requests are slow.
  if (!late(c, s, ['no-feedback-slow'])) await guard(c, s, ['no-feedback-slow'], '', async (env) => {
    const t = await open(c, s, env);
    t.faults.slowMs = 1500;
    await t.go();
    await sleep(500);
    const pending = t.api.pending;
    const fb = await t.page.evaluate(FEEDBACK);
    add('no-feedback-slow', s.id, pending === 0 || fb, pending === 0 ? 'no request in flight' : fb ? 'loading indication visible while a request was in flight' : `${pending} request(s) in flight at 500 ms and no spinner, busy state, loading text or animation`);
    await t.context.close();
  });

  // A failed request at load with no visible error.
  if (!late(c, s, ['failed-request-no-error'])) await guard(c, s, ['failed-request-no-error'], '', async (env) => {
    const t = await open(c, s, env);
    t.faults.failApi = true;
    await t.go();
    await sleep(900);
    const sent = t.api.seen.length;
    const n = await t.page.evaluate(ERRORISH);
    add('failed-request-no-error', `${s.id}:load`, sent === 0 || n > 0, sent === 0 ? 'no request sent' : n > 0 ? 'error text or alert shown' : `${sent} request(s) failed with 500, no error text or alert appeared`);
    await t.context.close();
  });
}

const MODE_PROBE = { repeat: 'repeat-requests', slow: 'no-feedback-slow', fail: 'failed-request-no-error' };

// Click every distinct clickable: repeat requests, then slow, then failing answers.
async function clickScreen(c, s, add) {
  if (c.noClicks) { for (const probe of Object.values(MODE_PROBE)) c.notChecked?.push({ probe, route: s.url || s.id, reason: `clicks not run: ${c.noClicks}` }); return; }
  if (late(c, s, Object.values(MODE_PROBE), 'clicks: ')) return;
  const TAG = tagClickables(c.maxClickables);
  let names = [], texts = [];
  await guard(c, s, Object.values(MODE_PROBE), 'clicks: ', async (env) => {
    const t = await open(c, s, env);
    await t.go();
    await idle(c, t.page);
    names = await t.page.evaluate(TAG);
    // What the filter reads: visible text plus aria-label, title, value and href (an icon-only button has no text).
    texts = await t.page.evaluate(`[...document.querySelectorAll('[data-rr-click]')].map((e) => [e.innerText, e.getAttribute('aria-label'), e.getAttribute('title'), e.value, e.getAttribute('href')].filter(Boolean).join(' '))`);
    await t.context.close();
  });
  const tasks = [];
  const rows = [];
  for (let i = 0; i < names.length; i++) {
    if (c.labelFilter && !c.labelFilter(`${names[i]} ${texts[i] || ''}`)) { c.skipped?.push({ route: s.url, label: names[i] }); continue; }
    const where = `${s.id}:click "${names[i]}"`;
    for (const mode of ['repeat', 'slow', 'fail']) {
      const slot = tasks.length;
      tasks.push(async () => {
        if (late(c, s, [MODE_PROBE[mode]], `click "${names[i]}": `)) return;
        await guard(c, s, [MODE_PROBE[mode]], `click "${names[i]}": `, async (env) => {
          const t = await open(c, s, env);
          await t.go();
          await idle(c, t.page);
          await t.page.evaluate(TAG);
          const target = t.page.locator(`[data-rr-click="${i}"]`).first();
          if (mode === 'slow') t.faults.slowMs = 1200;
          if (mode === 'fail') t.faults.failApi = true;
          const before = await t.page.evaluate(() => document.body.innerHTML);
          const errBefore = await t.page.evaluate(ERRORISH);
          t.api.seen.length = 0;
          try { await target.click({ timeout: 2000 }); } catch (e) {
            c.notChecked?.push({ probe: MODE_PROBE[mode], route: s.url || s.id, reason: closedReason(e) ? `click "${names[i]}": ${closedReason(e)}` : `could not click "${names[i]}"` });
            await t.context.close();
            return;
          }
          await sleep(mode === 'slow' ? 500 : 1500);
          const reqs = t.api.seen.length;
          if (mode === 'repeat') {
            const counts = {};
            for (const k of t.api.seen) counts[k] = (counts[k] || 0) + 1;
            const [k, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['', 0];
            rows[slot] = ['repeat-requests', where, n < 5, n < 5 ? `${reqs} request(s), none repeated more than ${n}x in 1.5 s` : `${n} identical requests in 1.5 s: ${k.replace(/^(\S+) https?:\/\/[^/]+/, '$1 ')}`];
          } else if (mode === 'slow') {
            const changed = (await t.page.evaluate(() => document.body.innerHTML)) !== before;
            const fb = await t.page.evaluate(FEEDBACK);
            rows[slot] = ['no-feedback-slow', where, t.api.pending === 0 || changed || fb, t.api.pending === 0 ? 'no request in flight' : changed || fb ? 'page changed while the request was in flight' : 'request in flight at 500 ms and nothing on the page changed'];
          } else {
            const errAfter = await t.page.evaluate(ERRORISH);
            rows[slot] = ['failed-request-no-error', where, reqs === 0 || errAfter > errBefore, reqs === 0 ? 'no request sent' : errAfter > errBefore ? 'error text or alert appeared' : `${reqs} request(s) answered 500 and no new error text or alert appeared`];
          }
          await t.context.close();
        });
      });
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(c.concurrency, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }));
  for (const r of rows) if (r) add(...r);
}

const finish = (c, timings) => { if (c.state.worstMs !== null) timings.push({ name: 'script-ms-per-key', value: Math.round(c.state.worstMs * 10) / 10, unit: 'ms' }); };

// Safe area: an iPhone's status bar, notch and home indicator cover part of the screen, and a control there cannot be tapped.
// Emulates 390x844 with touch and insets top 47 / bottom 34, in browser mode and in standalone (installed web app) mode.
// Fails on a visible interactive element that overlaps either band, or whose centre point is not the element or a descendant.
export const SAFE_AREA = { width: 390, height: 844, top: 47, bottom: 34 };
// CDP can set the insets (env() follows them) but not the display mode, so standalone is shimmed in JS (matchMedia, navigator.standalone).
// A CSS @media (display-mode) rule cannot be shimmed this way; the probe says so in its evidence.
const STANDALONE_SHIM = `(() => {
  const orig = window.matchMedia.bind(window);
  const yes = (q) => ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
  window.matchMedia = (q) => (/display-mode:\\s*standalone/.test(q) ? yes(q) : orig(q));
  Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
})()`;
const SAFE_EVAL = `(() => {
  const W = ${SAFE_AREA.width}, H = ${SAFE_AREA.height}, T = ${SAFE_AREA.top}, B = ${SAFE_AREA.bottom};
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[tabindex]:not([tabindex="-1"])';
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') + ' "' +(el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 30) + '"';
  // The part of an element's box that its scrolling ancestors let show.
  const clip = (el, r) => {
    let t = r.top, b = r.bottom, l = r.left, rt = r.right;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const q = p.getBoundingClientRect();
      t = Math.max(t, q.top); b = Math.min(b, q.bottom); l = Math.max(l, q.left); rt = Math.min(rt, q.right);
    }
    return { top: t, bottom: b, left: l, right: rt };
  };
  // Without viewport-fit=cover (the default, auto) Safari lays the page out inside the insets, so only a page that opts in can sit under them.
  const meta = document.querySelector('meta[name=viewport]');
  const cover = !!meta && /viewport-fit\\s*=\\s*cover/.test(meta.getAttribute('content') || '');
  const problems = []; let checked = 0;
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible' || cs.pointerEvents === 'none' || Number(cs.opacity) === 0) continue;
    if (el.closest('[hidden],[aria-hidden=true],[inert]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const c = clip(el, r);
    if (c.bottom <= c.top || c.right <= c.left) continue;
    if (c.bottom <= 0 || c.top >= H || c.right <= 0 || c.left >= W) continue; // not on screen
    checked++;
    if (cover && c.top < T && c.bottom > 0) problems.push(name(el) + ' sits in the top inset (y ' + Math.round(c.top) + '-' + Math.round(c.bottom) + ', inset 0-' + T + ')');
    if (cover && c.bottom > H - B && c.top < H) problems.push(name(el) + ' sits in the bottom inset (y ' + Math.round(c.top) + '-' + Math.round(c.bottom) + ', inset ' + (H - B) + '-' + H + ')');
    const mx = (Math.max(c.left, 0) + Math.min(c.right, W)) / 2, my = (Math.max(c.top, 0) + Math.min(c.bottom, H)) / 2;
    const hit = document.elementFromPoint(mx, my);
    if (hit && hit !== el && !el.contains(hit)) problems.push(name(el) + ' is covered at its centre by ' + name(hit));
  }
  const probe = document.createElement('div'); probe.style.paddingTop = 'env(safe-area-inset-top)'; document.body.append(probe);
  const env = parseFloat(getComputedStyle(probe).paddingTop); probe.remove();
  return { checked, problems, env, cover };
})()`;

// One screen, both modes. A failed probe (no CDP support, a page error) becomes notChecked via guard.
async function safeAreaScreen(c, s, add) {
  for (const mode of ['browser', 'standalone']) {
    if (late(c, s, ['safe-area'], `${mode}: `)) return;
    await guard(c, s, ['safe-area'], `${mode}: `, async (env) => {
      const url = new URL(s.url, c.origin).toString();
      const { context } = await makeContext(c.browser, c.origin, { viewport: { width: SAFE_AREA.width, height: SAFE_AREA.height }, mobile: true, touch: true, ...env, faults: {} });
      try {
        if (mode === 'standalone') await context.addInitScript(STANDALONE_SHIM);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: SAFE_AREA.top, bottom: SAFE_AREA.bottom, left: 0, right: 0 } });
        await page.goto(url, { waitUntil: 'load' });
        await idle(c, page);
        const r = await page.evaluate(SAFE_EVAL);
        const shown = r.problems.slice(0, 3).join('; ');
        const notes = [];
        if (!r.cover) notes.push('page lacks viewport-fit=cover, so its bands were not checked');
        if (r.env !== SAFE_AREA.top) notes.push(`env(safe-area-inset-top) is ${r.env}px`);
        if (mode === 'standalone') notes.push('display mode shimmed in JS; a CSS display-mode rule is not emulated');
        const note = notes.length ? `; ${notes.join('; ')}` : '';
        add('safe-area', `${s.id}:${mode}`, r.problems.length === 0, r.problems.length ? `${r.problems.length} problem(s): ${shown}${note}` : `${r.checked} control(s) clear of the insets${note}`);
      } finally { await context.close().catch(() => {}); }
    });
  }
}

// Load probes (console errors, typing, script cost, layout shift, slow and failed answers at load) on each screen.
export async function loadProbes({ browser, origin, screens, timings = [], ...opts }) {
  const c = setup({ browser, origin, ...opts }), out = [];
  const add = (probe, screen, passed, evidence, extra) => out.push({ probe, screen, passed, evidence, ...extra });
  for (const s of screens) await loadScreen(c, s, add);
  for (const s of screens) await safeAreaScreen(c, s, add);
  finish(c, timings);
  return out;
}

// The safe-area probe alone (for tests and for callers that want only it).
export async function safeAreaProbes({ browser, origin, screens, ...opts }) {
  const c = setup({ browser, origin, ...opts }), out = [];
  const add = (probe, screen, passed, evidence, extra) => out.push({ probe, screen, passed, evidence, ...extra });
  for (const s of screens) await safeAreaScreen(c, s, add);
  return out;
}

// Click probes on each screen.
export async function clickProbes({ browser, origin, screens, ...opts }) {
  const c = setup({ browser, origin, ...opts }), out = [];
  const add = (probe, screen, passed, evidence, extra) => out.push({ probe, screen, passed, evidence, ...extra });
  for (const s of screens) await clickScreen(c, s, add);
  return out;
}

// Both, screen by screen: what capture runs.
export async function runProbes({ browser, origin, screens, timings = [], ...opts }) {
  const c = setup({ browser, origin, ...opts }), out = [];
  const add = (probe, screen, passed, evidence, extra) => out.push({ probe, screen, passed, evidence, ...extra });
  for (const s of screens) { await loadScreen(c, s, add); await clickScreen(c, s, add); }
  finish(c, timings);
  return out;
}

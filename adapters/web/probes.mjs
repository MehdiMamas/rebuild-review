// Interaction probes. Each is a general check for one kind of failure; none knows the app.
// Result rows: { probe, screen, passed, evidence }. passed=false means the probe flagged a problem.
import { makeContext, sleep } from './context.mjs';

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
const TAG_CLICKABLES = `(() => {
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
    if (n >= 10) break;
  }
  return [...document.querySelectorAll('[data-rr-click]')].map((e) => (e.innerText || e.tagName).trim().slice(0, 30));
})()`;
const SNAP = `(() => { window.__rects = new Map(); for (const e of document.body.querySelectorAll('*')) { const r = e.getBoundingClientRect(); window.__rects.set(e, [r.left, r.top]); } })()`;
const MOVED = `(() => {
  let worst = { d: 0 };
  for (const [e, [x, y]] of window.__rects) {
    if (!e.isConnected) continue;
    const r = e.getBoundingClientRect(), d = Math.max(Math.abs(r.top - y), Math.abs(r.left - x));
    if (d > worst.d) worst = { d, el: e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') };
  }
  return worst;
})()`;
const WATCH = `(() => {
  window.__ls = 0; window.__maxEvt = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__ls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__maxEvt = Math.max(window.__maxEvt, e.duration); }).observe({ type: 'event', durationThreshold: 16, buffered: true });
})()`;

async function open(browser, origin, url, opts = {}) {
  const faults = {};
  const { context, rec } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 }, ...opts, faults });
  const page = await context.newPage();
  await page.addInitScript(WATCH);
  const api = { pending: 0, seen: [] };
  page.on('request', (r) => {
    if (['fetch', 'xhr'].includes(r.resourceType())) { api.pending++; api.seen.push(`${r.method()} ${r.url()}`); }
  });
  const done = (r) => ['fetch', 'xhr'].includes(r.resourceType()) && api.pending--;
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return { context, rec, page, faults, api, go: () => page.goto(url, { waitUntil: 'load' }) };
}

export async function runProbes({ browser, origin, screens }) {
  const out = [];
  const add = (probe, screen, passed, evidence) => out.push({ probe, screen, passed, evidence });

  for (const s of screens) {
    const url = new URL(s.url, origin).toString();

    // Console errors, plain load; also focus-lost and input delay while typing into every text field.
    {
      const t = await open(browser, origin, url);
      const cdp = await t.context.newCDPSession(t.page);
      await t.go();
      await t.page.waitForLoadState('networkidle').catch(() => {});
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const errs = [...t.rec.console, ...t.rec.pageErrors];
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
      add('input-delay', s.id, worst < 50, `slowest input event ${Math.round(worst)} ms at 4x CPU slowdown${worstField ? ` in ${worstField}` : ''}; budget 50 ms`);
      await t.context.close();
    }

    // Layout shift on load, both sizes, with and without slow API answers. Two signals: the browser's
    // layout-shift entries, and any element present early that later moved 8 px or more (an empty
    // container the content later pushes down produces no entry, but is a shift all the same).
    for (const width of [390, 1440]) {
      for (const slowMs of [0, 1500]) {
        const t = await open(browser, origin, url, { viewport: { width, height: 900 } });
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

    // No visible feedback while the page's own requests are slow.
    {
      const t = await open(browser, origin, url);
      t.faults.slowMs = 1500;
      await t.go();
      await sleep(500);
      const pending = t.api.pending;
      const fb = await t.page.evaluate(FEEDBACK);
      add('no-feedback-slow', s.id, pending === 0 || fb, pending === 0 ? 'no request in flight' : fb ? 'loading indication visible while a request was in flight' : `${pending} request(s) in flight at 500 ms and no spinner, busy state, loading text or animation`);
      await t.context.close();
    }

    // A failed request at load with no visible error.
    {
      const t = await open(browser, origin, url);
      t.faults.failApi = true;
      await t.go();
      await sleep(900);
      const sent = t.api.seen.length;
      const n = await t.page.evaluate(ERRORISH);
      add('failed-request-no-error', `${s.id}:load`, sent === 0 || n > 0, sent === 0 ? 'no request sent' : n > 0 ? 'error text or alert shown' : `${sent} request(s) failed with 500, no error text or alert appeared`);
      await t.context.close();
    }

    // Click every distinct clickable: repeat requests, then slow, then failing answers.
    const names = await (async () => {
      const t = await open(browser, origin, url);
      await t.go();
      await t.page.waitForLoadState('networkidle').catch(() => {});
      const n = await t.page.evaluate(TAG_CLICKABLES);
      await t.context.close();
      return n;
    })();
    for (let i = 0; i < names.length; i++) {
      const where = `${s.id}:click "${names[i]}"`;
      for (const mode of ['repeat', 'slow', 'fail']) {
        const t = await open(browser, origin, url);
        await t.go();
        await t.page.waitForLoadState('networkidle').catch(() => {});
        await t.page.evaluate(TAG_CLICKABLES);
        const target = t.page.locator(`[data-rr-click="${i}"]`).first();
        if (mode === 'slow') t.faults.slowMs = 1200;
        if (mode === 'fail') t.faults.failApi = true;
        const before = await t.page.evaluate(() => document.body.innerHTML);
        const errBefore = await t.page.evaluate(ERRORISH);
        t.api.seen.length = 0;
        try { await target.click({ timeout: 2000 }); } catch { await t.context.close(); continue; }
        await sleep(mode === 'slow' ? 500 : 1500);
        const reqs = t.api.seen.length;
        if (mode === 'repeat') {
          const counts = {};
          for (const k of t.api.seen) counts[k] = (counts[k] || 0) + 1;
          const [k, c] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['', 0];
          add('repeat-requests', where, c < 5, c < 5 ? `${reqs} request(s), none repeated more than ${c}x in 1.5 s` : `${c} identical requests in 1.5 s: ${k.replace(/^(\S+) https?:\/\/[^/]+/, '$1 ')}`);
        } else if (mode === 'slow') {
          const changed = (await t.page.evaluate(() => document.body.innerHTML)) !== before;
          const fb = await t.page.evaluate(FEEDBACK);
          add('no-feedback-slow', where, t.api.pending === 0 || changed || fb, t.api.pending === 0 ? 'no request in flight' : changed || fb ? 'page changed while the request was in flight' : 'request in flight at 500 ms and nothing on the page changed');
        } else {
          const errAfter = await t.page.evaluate(ERRORISH);
          add('failed-request-no-error', where, reqs === 0 || errAfter > errBefore, reqs === 0 ? 'no request sent' : errAfter > errBefore ? 'error text or alert appeared' : `${reqs} request(s) answered 500 and no new error text or alert appeared`);
        }
        await t.context.close();
      }
    }
  }
  return out;
}

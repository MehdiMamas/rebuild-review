// Per-change check of a running web app. Exit: 0 pass, 1 fail, 2 incomplete (something not checked), 3 error.
// node check.mjs --base-url <url> --routes /a,/b [--out dir] [--budget-seconds 110] [--storage-state file] [--allow-origin https://x,...] [--wait-for <css selector>]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeContext } from './context.mjs';
import { launchChromium } from './browser.mjs';
import { loadProbes, clickProbes } from './probes.mjs';
import { statusOf, exitCodeOf, endedOn, notesOf } from './check-result.mjs';

const t0 = Date.now();
// A throw nobody handled is an error (3), never a failed check (1).
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, (e) => { console.error(`error: ${String(e?.message ?? e).split('\n')[0]}`); process.exit(3); });
const die = (msg) => { console.error(`error: ${msg}`); process.exit(exitCodeOf('error')); };
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

const baseUrl = arg('base-url'), routesArg = arg('routes');
if (!baseUrl || !routesArg) die('--base-url and --routes are required');
let base;
try { base = new URL(baseUrl); } catch { die(`bad --base-url ${baseUrl}`); }
if (!/^https?:$/.test(base.protocol)) die(`bad --base-url ${baseUrl}`);
const routes = routesArg.split(',').map((r) => r.trim()).filter(Boolean);
if (!routes.length || routes.some((r) => !r.startsWith('/'))) die(`--routes must be paths starting with /, got ${routesArg}`);
const budget = arg('budget-seconds') === undefined ? 110 : Number(arg('budget-seconds'));
if (!(budget > 0)) die(`bad --budget-seconds ${arg('budget-seconds')}`);
const storageState = arg('storage-state');
if (storageState && !fs.existsSync(storageState)) die(`--storage-state ${storageState} not found`);
const allowOrigins = (arg('allow-origin') || '').split(',').map((o) => o.trim()).filter(Boolean);
const waitFor = arg('wait-for');
if (waitFor !== undefined && !waitFor.trim()) die('bad --wait-for: empty');
const out = arg('out');
if (out) fs.mkdirSync(out, { recursive: true });
const deadline = t0 + budget * 1000;
const origin = base.origin;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);

if (!(await fetch(origin).then(() => true, () => false))) die(`app does not answer on ${origin}`);
let browser;
try { browser = await launchChromium(chromium, { args: ['--disable-gpu', '--disable-software-rasterizer'] }); } catch (e) { die(`browser could not start: ${e.message}`); }

const slug = (u) => u.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_') || 'root';
const blocked = new Set(), notChecked = [], reached = [], screenshots = [], notes = [];
// A polling app never goes idle: cap each idle wait; other waits fail fast instead of eating the budget.
const env = { storageState, allowOrigins, onBlocked: (u) => blocked.add(u), timeout: 5000, navTimeout: 15000 };

// Headless needs no GPU or software GL; with them the first screenshots can stall for tens of seconds (seen under WSL). WebGL is off.
// Warm the browser once with one throwaway shot so the routes' screenshots do not pay for a cold start.
{
  const { context } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 }, ...env });
  await context.newPage().then(async (p) => { await p.goto(origin, { waitUntil: 'load', timeout: 15000 }); await p.screenshot({ timeout: 15000 }); }).catch(() => {});
  await context.close();
}

// A route that ends on another path (a redirect to login) or an origin not allowed is not checked.
for (const route of routes) {
  const { context } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 }, ...env });
  try {
    const page = await context.newPage();
    await page.goto(new URL(route, origin).toString(), { waitUntil: 'load', timeout: 15000 });
    const ended = endedOn(new URL(route, origin).toString(), page.url(), allowOrigins);
    // Screenshots come first for every route, before any probe, so a cut budget never loses them.
    if (out) {
      const idleLeft = Math.min(10000, deadline - Date.now());
      if (idleLeft > 0) await page.waitForLoadState('networkidle', { timeout: idleLeft }).catch(() => {});
      if (waitFor) {
        const left = Math.min(10000, deadline - Date.now());
        if (left <= 0) notes.push({ route, note: `wait-for ${waitFor} not waited for: no time left before the deadline; shots taken anyway` });
        else {
          try { await page.waitForSelector(waitFor, { state: 'visible', timeout: left }); } catch (e) {
            const first = String(e.message).split('\n')[0];
            if (e?.name === 'TimeoutError') notes.push({ route, note: `wait-for ${waitFor} not visible after ${Math.round(left / 1000)} s; shots taken anyway` });
            else die(`bad --wait-for: ${first}`);
          }
        }
      }
      for (const width of [1440, 390]) {
        try {
          await page.setViewportSize({ width, height: 900 });
          const file = `${slug(route)}-${width}.png`;
          await page.screenshot({ path: path.join(out, file), fullPage: true, timeout: 15000 });
          screenshots.push({ route, width, file });
        } catch (e) { notChecked.push({ probe: 'screenshot', route, reason: `${width} px: ${String(e.message).split('\n')[0]}` }); }
      }
    }
    if (ended) notChecked.push({ probe: 'all', route, reason: ended });
    else reached.push({ id: slug(route), url: route });
  } catch (e) {
    if (out) for (const width of [1440, 390]) notChecked.push({ probe: 'screenshot', route, reason: `${width} px: route did not load` });
    notChecked.push({ probe: 'all', route, reason: `did not load: ${String(e.message).split('\n')[0]}` });
  }
  await context.close();
}

const rows = [];
// A --storage-state file is a sign-in session: a route that sends it to a sign-in page is not probed (#161).
const common = { browser, origin, screens: reached, deadline, notChecked, idleMs: 3000, signedIn: Boolean(storageState), ...env };
rows.push(...await loadProbes({ ...common, ignoreBlocked: true }));
// Clicks that look destructive or outward-facing are skipped and listed; on a non-local app no click runs.
const RISKY = /\b(delete|remove|destroy|pay|buy|purchase|checkout|send|publish|sign[\s-]?out|log[\s-]?out|unsubscribe|deactivate|trash|discard|reset|archive|revoke|wipe|clear|drop)\b/i;
const skipped = [];
rows.push(...await clickProbes({ ...common, concurrency: 4, labelFilter: (l) => !RISKY.test(l), skipped, noClicks: local ? undefined : 'the app is not local, a click could act on real data' }));
for (const k of skipped) notChecked.push({ probe: 'click', route: k.route, reason: `skipped "${k.label}": looks destructive or outward-facing` });
await browser.close();

// A row's screen is the route's id, then '@390', or ':' and detail; give the route and put the detail before the evidence.
const routeOf = (screen) => {
  const hit = reached.filter((r) => screen === r.id || screen.startsWith(r.id + ':') || screen.startsWith(r.id + '@')).sort((a, b) => b.id.length - a.id.length)[0];
  return hit ? { route: hit.url, rest: screen.slice(hit.id.length).replace(/^:/, '') } : { route: screen, rest: '' };
};
const failed = rows.filter((r) => !r.passed).map((r) => { const { route, rest } = routeOf(r.screen); return { probe: r.probe, route, evidence: rest ? `${rest}: ${r.evidence}` : r.evidence, ...(r.value !== undefined && { value: r.value, unit: r.unit }) }; });
const status = statusOf({ failed, notChecked });
const result = { version: 1, status, baseUrl, routes, screenshots, elapsedMs: Date.now() - t0, passed: rows.length - failed.length, failed, notChecked, notes: notesOf(notes), blockedOrigins: [...new Set([...blocked].map((u) => { try { return new URL(u).origin; } catch { return u; } }))].sort() };
if (out) fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
for (const f of failed) console.log(`FAIL ${f.probe} ${f.route}: ${f.evidence}`);
for (const n of notes) console.log(`NOTE ${n.route}: ${n.note}`);
for (const n of notChecked) console.log(`NOT CHECKED ${n.probe} ${n.route}: ${n.reason}`);
console.log(`${status}: ${result.passed} passed, ${failed.length} failed, ${notChecked.length} not checked, ${blocked.size} blocked origin request(s), ${(result.elapsedMs / 1000).toFixed(1)} s`);
process.exit(exitCodeOf(status));

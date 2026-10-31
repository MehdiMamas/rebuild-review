// Per-change check of a running web app. Exit: 0 pass, 1 fail, 2 incomplete (something not checked), 3 error.
// node check.mjs --base-url <url> --routes /a,/b [--out result.json] [--budget-seconds 110] [--storage-state file] [--allow-origin https://x,...]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeContext } from './context.mjs';
import { loadProbes, clickProbes } from './probes.mjs';
import { statusOf, exitCodeOf } from './check-result.mjs';

const t0 = Date.now();
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
const out = arg('out');
const deadline = t0 + budget * 1000;
const origin = base.origin;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);

if (!(await fetch(origin).then(() => true, () => false))) die(`app does not answer on ${origin}`);
let browser;
try { browser = await chromium.launch(); } catch (e) { die(`browser could not start: ${String(e.message).split('\n')[0]}`); }

const slug = (u) => u.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '-') || 'root';
const blocked = new Set(), notChecked = [], reached = [];
const env = { storageState, allowOrigins, onBlocked: (u) => blocked.add(u) };

// A route that ends on another path (a redirect to login) is not checked.
for (const route of routes) {
  const { context } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 }, ...env });
  try {
    const page = await context.newPage();
    await page.goto(new URL(route, origin).toString(), { waitUntil: 'load', timeout: 15000 });
    const want = new URL(route, origin).pathname.replace(/\/$/, ''), got = new URL(page.url()).pathname.replace(/\/$/, '');
    if (want !== got) notChecked.push({ probe: 'all', route, reason: `ended on ${got || '/'} instead` });
    else reached.push({ id: slug(route), url: route });
  } catch (e) {
    notChecked.push({ probe: 'all', route, reason: `did not load: ${String(e.message).split('\n')[0]}` });
  }
  await context.close();
}

const rows = [];
const common = { browser, origin, screens: reached, deadline, notChecked, ...env };
rows.push(...await loadProbes({ ...common, ignoreBlocked: true }));
// Clicks that look destructive or outward-facing are skipped and listed; on a non-local app no click runs.
const RISKY = /\b(delete|remove|destroy|pay|buy|purchase|checkout|send|publish|sign\s?out|log\s?out|unsubscribe|deactivate)\b/i;
const skipped = [];
rows.push(...await clickProbes({ ...common, concurrency: 4, labelFilter: (l) => !RISKY.test(l), skipped, noClicks: local ? undefined : 'the app is not local, a click could act on real data' }));
for (const k of skipped) notChecked.push({ probe: 'click', route: k.route, reason: `skipped "${k.label}": looks destructive or outward-facing` });
await browser.close();

const failed = rows.filter((r) => !r.passed).map((r) => ({ probe: r.probe, route: r.screen, evidence: r.evidence }));
const status = statusOf({ failed, notChecked });
const result = { version: 1, status, baseUrl, routes, elapsedMs: Date.now() - t0, passed: rows.length - failed.length, failed, notChecked, blockedOrigins: [...new Set([...blocked].map((u) => { try { return new URL(u).origin; } catch { return u; } }))].sort() };
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2)); }
for (const f of failed) console.log(`FAIL ${f.probe} ${f.route}: ${f.evidence}`);
for (const n of notChecked) console.log(`NOT CHECKED ${n.probe} ${n.route}: ${n.reason}`);
console.log(`${status}: ${result.passed} passed, ${failed.length} failed, ${notChecked.length} not checked, ${blocked.size} blocked origin request(s), ${(result.elapsedMs / 1000).toFixed(1)} s`);
process.exit(exitCodeOf(status));

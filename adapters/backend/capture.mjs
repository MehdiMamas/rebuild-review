// Backend capture adapter. node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json] [--max-screens N]
// run.json: { platform: "backend", dir?, install?, build?, start, address, openapi?, readyPath?, env? }
// A screen is one operation plus one state (`GET /items`, `POST /items`). Safe methods run first on a fresh store; every mutating one
// runs after a restart with empty temp storage, so a delete never changes the next screen. Each screen is captured twice and the
// JSON values that differ become "<varies>". states.json steps: { method, path, headers?, query?, body?, save?: { name: "a.b.0" } };
// "{name}" in a later path or string value is replaced by the saved value; the last step of a state is the screen.
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from '../web/context.mjs';
import { prepare, start, stop, restart, call, networkMode, scrubDeep } from './api.mjs';
import { operations, MUTATING } from './discover.mjs';
import { runProbes } from './probes.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const out = path.resolve(arg('out') || '');
const statesFile = arg('states');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'backend') throw new Error(`backend adapter cannot capture platform "${run.platform}"`);
const MAX_SCREENS = Number(arg('max-screens')) || 30;
const CALL_MS = 10000;
const ctx = prepare(run, appFile);

const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const notCaptured = [], timings = [], log = [], screens = [], volatile = {}, operationsSkipped = [], cutScreens = [], notChecked = [];
const used = new Set();
const uniqueId = (want) => { let id = want || 'screen', n = 2; const b = id; while (used.has(id)) id = `${b}-${n++}`; used.add(id); return id; };

const go = async (screen, req, label, { record = true } = {}) => {
  const started = new Date().toISOString();
  const res = await call(ctx, req);
  if (record) log.push({ screen, label, req, res, started });
  return res;
};

// Differing JSON values (or a differing text body) become "<varies>"; returns the masked body and the paths that varied.
function mask(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return { value: a, paths: [] };
  const isObj = (v) => v && typeof v === 'object';
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const paths = [];
    const value = a.map((x, i) => { const r = mask(x, b[i], `${at}[${i}]`); paths.push(...r.paths); return r.value; });
    return { value, paths };
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b) && Object.keys(a).sort().join() === Object.keys(b).sort().join()) {
    const paths = [], value = {};
    for (const k of Object.keys(a)) { const r = mask(a[k], b[k], at ? `${at}.${k}` : k); paths.push(...r.paths); value[k] = r.value; }
    return { value, paths };
  }
  return { value: '<varies>', paths: [at || '(body)'] };
}

const fill = (v, vars) => {
  if (typeof v === 'string') return v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
};
const dig = (body, p) => String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), body);

// One screen: two captures. fresh: restart with empty storage before each. steps run before the last request.
async function capture(id, steps, { fresh }) {
  const results = [];
  for (let pass = 0; pass < 2; pass++) {
    if (fresh) await restart(ctx, { fresh: true });
    const vars = {};
    let last = null, lastReq = null;
    for (let i = 0; i < steps.length; i++) {
      const req = { ...fill(steps[i], vars), timeoutMs: CALL_MS };
      delete req.save;
      const final = i === steps.length - 1;
      last = await go(id, req, final ? undefined : 'setup');
      lastReq = req;
      if (steps[i].save) for (const [k, p] of Object.entries(steps[i].save)) vars[k] = dig(last.body, p);
    }
    results.push({ req: lastReq, res: last });
    if (last.error === 'timeout') break; // a hung route is not captured twice
  }
  const [a, b] = results;
  let body = a.res.body, paths = [], statusVaries = false;
  if (b) {
    if (a.res.status !== b.res.status) statusVaries = true;
    else if (!a.res.binary && !b.res.binary) { const m = mask(a.res.body, b.res.body); body = m.value; paths = m.paths; }
  }
  if (paths.length) volatile[id] = paths;
  if (statusVaries) notCaptured.push(`${id}: the status differed between two captures (${a.res.status}, ${b.res.status}); the first is kept`);
  if (!b) notCaptured.push(`${id}: captured once (the request did not finish in ${CALL_MS / 1000} s), so volatile values were not checked`);
  return { id, req: a.req, res: { ...a.res, body } };
}

// 1. Discovery on the fresh store.
await start(ctx);
const found = await operations(ctx);
for (const n of found.notes) notCaptured.push(n);
const safe = [], mutating = [];
for (const op of found.operations) {
  if (!op.request) { operationsSkipped.push({ method: op.method, path: op.path, reason: op.skip || 'no request could be built' }); continue; }
  if (op.skip) { operationsSkipped.push({ method: op.method, path: op.path, reason: op.skip }); continue; }
  if (op.security) operationsSkipped.push({ method: op.method, path: op.path, reason: 'needs credentials; none were invented, so the answer without them is the behaviour recorded' });
  (MUTATING.has(op.method) ? mutating : safe).push(op);
}

// 2. Screens: safe operations, then states, then mutating operations; the cap stops the rest.
const states = statesFile ? JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8')) : [];
const plan = [
  ...safe.map((op) => ({ id: slug(`${op.method} ${op.path}`), steps: [op.request], fresh: false, op })),
  ...states.map((st) => ({ id: slug(st.id) || 'state', steps: st.steps || [], fresh: true, state: true })),
  ...mutating.map((op) => ({ id: slug(`${op.method} ${op.path}`), steps: [op.request], fresh: true, op })),
];
const captured = [];
for (const item of plan) {
  if (captured.length >= MAX_SCREENS) { cutScreens.push(item.state ? `state ${item.id}` : `${item.op.method} ${item.op.path}`); continue; }
  const id = uniqueId(item.id);
  try {
    if (item.state && !item.steps.length) throw new Error('no steps');
    if (!item.fresh && !ctx.proc) await restart(ctx, { fresh: true });
    const c = await capture(id, item.steps, { fresh: item.fresh });
    captured.push({ ...c, state: !!item.state, op: item.op, steps: item.state ? item.steps : undefined });
  } catch (e) { notCaptured.push(`${item.state ? 'state ' : ''}${id}: ${scrub(e.message).split('\n')[0]}`); }
}
if (cutScreens.length) notCaptured.push(`discovery stopped at ${MAX_SCREENS} screens; ${cutScreens.length} more found and not captured`);

// 3. Probes (they make a few more calls of their own) on the fresh store.
await restart(ctx, { fresh: true });
const probeScreens = captured.map((c) => ({ id: c.id, req: c.req, res: c.res }));
const probes = await runProbes({ ctx, go, screens: probeScreens, log, timings, notChecked });
timings.unshift({ name: 'startup-ms', value: ctx.startupMs, unit: 'ms' });
for (const c of captured) timings.push({ name: `${c.id}.ms`, value: c.res.ms, unit: 'ms' });
if (ctx.buildMs !== null) timings.push({ name: 'build-ms', value: ctx.buildMs, unit: 'ms' });
const serviceLog = ctx.log;
await stop(ctx, { removeRoot: true });

// 4. Write the golden folder. Bodies are scrubbed after the volatile values were found (a UUID looks like a token).
for (const c of captured) {
  const dir = path.join(out, 'screens', c.id);
  const { req, res } = c;
  write(path.join(dir, 'request.json'), JSON.stringify(scrubDeep({ method: req.method || 'GET', path: req.path, ...(req.query ? { query: req.query } : {}), ...(req.headers ? { headers: req.headers } : {}), ...(req.body !== undefined ? { body: req.body } : {}) }), null, 2));
  let body = res.body;
  if (res.binary) {
    notCaptured.push(`${c.id}: the body is not text; only its size is kept`);
    body = { binary: true, bytes: res.bytes };
  } else body = scrubDeep(body);
  write(path.join(dir, 'response.json'), JSON.stringify({ status: res.status, headers: scrubDeep(res.headers), body }, null, 2));
  write(path.join(dir, 'result.json'), JSON.stringify({ ms: res.ms, bytes: res.bytes, cut: !!res.cut, ...(res.error ? { error: scrub(res.error) } : {}) }, null, 2));
  if (res.cut) notCaptured.push(`${c.id}: the body was cut at 1 MB`);
  if (res.error === 'timeout') notCaptured.push(`${c.id}: the request was still open after ${CALL_MS / 1000} s and was stopped`);
  else if (res.error) notCaptured.push(`${c.id}: ${scrub(res.error)}`);
}

const entries = log.map((e) => {
  const url = new URL(e.req.path, run.address);
  for (const [k, v] of Object.entries(e.req.query || {})) url.searchParams.set(k, String(v));
  const ct = e.res.headers['content-type'] || '';
  const text = e.res.binary ? '' : (typeof e.res.body === 'string' ? e.res.body : JSON.stringify(e.res.body));
  return scrubDeep({
    startedDateTime: e.started, time: e.res.ms,
    request: { method: e.req.method || 'GET', url: url.toString(), headers: Object.entries(e.req.headers || {}).map(([name, value]) => ({ name, value: String(value) })),
      queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
      ...(e.req.body !== undefined ? { postData: { mimeType: 'application/json', text: typeof e.req.body === 'string' ? e.req.body.slice(0, 20000) : JSON.stringify(e.req.body).slice(0, 20000) } } : {}) },
    response: { status: e.res.status, headers: Object.entries(e.res.headers).map(([name, value]) => ({ name, value })), content: { size: e.res.bytes, mimeType: ct, text } },
    ...(e.label ? { comment: e.label } : {}),
  });
});
write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review backend adapter', version: '1' }, entries } });

notCaptured.push('no screens or screenshots: HTTP service');
notCaptured.push(networkMode() === 'namespace'
  ? 'network is blocked with a network namespace for the service and not observed'
  : 'network: proxy mode, raw connections not blocked (the service is pointed at a dead proxy; a service that opens raw TCP or ignores proxy variables can still reach out; outbound calls are not observed)');
let appVersion = run.appVersion || null;
if (!appVersion) try { appVersion = JSON.parse(fs.readFileSync(path.join(ctx.workDir, 'package.json'), 'utf8')).version || null; } catch {}
write(path.join(out, 'manifest.json'), scrub(JSON.stringify({
  platform: 'backend', appVersion,
  screens: captured.map((c) => ({ id: c.id, method: c.req.method || 'GET', path: c.op ? c.op.path : c.req.path, ...(c.steps ? { steps: c.steps } : {}), ...(c.state ? { state: true } : {}) })),
  states: captured.filter((c) => c.state).map((c) => c.id),
  volatile, networkMode: networkMode(), discovery: found.source,
  blockedRequests: [],
  notCaptured: [...notCaptured, ...notChecked.map((r) => scrub(`${r.probe} ${r.route}: ${r.reason}`))],
}, null, 2)));
write(path.join(out, 'coverage.json'), {
  caps: { maxScreens: MAX_SCREENS }, screensReached: captured.map((c) => c.id), screensCut: cutScreens, buttonsSkipped: [],
  operationsSkipped, surfaceKnown: found.surfaceKnown, harEntriesSkipped: 0,
});
write(path.join(out, 'timings.json'), timings);
write(path.join(out, 'probes.json'), probes);
write(path.join(out, 'probes-not-checked.json'), notChecked);
const consoleText = scrub(serviceLog).split('\n').filter(Boolean).map((l) => `[service] ${l}`);
write(path.join(out, 'console.log'), consoleText.join('\n') + (consoleText.length ? '\n' : ''));
console.log(`captured ${captured.length} screens, ${captured.filter((c) => c.state).length} states, ${probes.filter((p) => !p.passed).length} probe flags -> ${out}`);
process.exit(0);

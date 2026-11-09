// Library capture adapter. node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json] [--max-symbols N]
// run.json: { platform: "library", language: "node", dir?, install?, build?, entry?, env? }
// A screen is one call sequence. Screens come from states.json ({ id, subpath?, steps }) and from one generated smoke call per exported
// function or class. Each screen runs twice; values that differ are written "<varies>" and listed in manifest "volatile".
// Steps: { call, args }, { new, as, args }, { get }, { list: true }. Tagged values: see harness.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from '../web/context.mjs';
import { prepare, runSteps, networkMode } from './run.mjs';
import { readSurface } from './surface.mjs';
import { runProbes } from './probes.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const out = path.resolve(arg('out') || '');
const statesFile = arg('states');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'library') throw new Error(`library adapter cannot capture platform "${run.platform}"`);
const MAX_SYMBOLS = Number(arg('max-symbols')) || 200;
const ctx = prepare(run, appFile);

const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const notCaptured = [], callsSkipped = [], timings = [], consoleLines = [], runs = [], screens = [], volatile = [];
const used = new Set();
const uniqueId = (want) => { let id = want || 'screen', n = 2; const b = id; while (used.has(id)) id = `${b}-${n++}`; used.add(id); return id; };

const surface = await readSurface(ctx, { maxSymbols: MAX_SYMBOLS });

// The smallest value of a declared type; null when there is none to give.
const STREAMISH = /\b(Readable|Writable|Duplex|Transform|Stream|Socket|FileHandle|ReadStream|WriteStream|Buffer|ReadableStream|WritableStream)\b/;
function minimal(type) {
  const t = String(type).trim();
  if (STREAMISH.test(t)) return { skip: true };
  if (/=>/.test(t) || /^Function$/.test(t)) return { v: { $: 'cb', returns: { $: 'undefined' } } };
  const lit = /^(?:["'`]([^"'`]*)["'`]|(-?\d+(?:\.\d+)?)|true|false)(?:\s*\|.*)?$/.exec(t);
  if (lit) return { v: lit[1] !== undefined ? lit[1] : lit[2] !== undefined ? Number(lit[2]) : t.startsWith('true') }; 
  if (/^string\b/.test(t)) return { v: '' };
  if (/^number\b/.test(t)) return { v: 0 };
  if (/^boolean\b/.test(t)) return { v: false };
  if (/^bigint\b/.test(t)) return { v: { $: 'bigint', v: '0' } };
  if (/\[\]$/.test(t) || /^(Readonly)?Array</.test(t)) return { v: [] };
  if (/^Date$/.test(t)) return { v: { $: 'Date', v: '2020-01-01T00:00:00.000Z' } };
  if (/^(any|unknown)$/.test(t)) return { v: null };
  return { v: {} };
}

// 1. Generated smoke screens, then states.
for (const s of surface.symbols) {
  if (!['function', 'class'].includes(s.kind)) continue;
  const params = s.params || [];
  const required = params.filter((p) => !p.optional);
  const typed = [];
  let skip = null;
  for (const p of required) { const m = minimal(p.type); if (m.skip) { skip = p; break; } typed.push(m.v); }
  const base = slug(`${s.subpath === '.' ? '' : s.subpath}-${s.name}`);
  if (skip) { callsSkipped.push({ symbol: `${s.subpath}:${s.name}`, reason: `parameter ${skip.name}: ${skip.type} cannot be made without a live handle` }); continue; }
  const mk = (args) => (s.kind === 'class' ? [{ new: s.name, as: 'inst', args }] : [{ call: s.name, args }]);
  if (required.length) screens.push({ id: uniqueId(`${base}-noargs`), subpath: s.subpath, steps: mk([]), generated: true });
  screens.push({ id: uniqueId(base), subpath: s.subpath, steps: mk(typed), generated: true });
}
for (const s of surface.symbols) if (s.kind === 'const') screens.push({ id: uniqueId(slug(`${s.subpath === '.' ? '' : s.subpath}-${s.name}`)), subpath: s.subpath, steps: [{ get: s.name }], generated: true });
if (surface.symbols.every((s) => s.kind === 'unknown') && surface.symbols.length) screens.push({ id: uniqueId('exports'), subpath: '.', steps: [{ list: true }], generated: true });
const stateIds = [];
if (statesFile) {
  for (const st of JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8'))) {
    const id = uniqueId(slug(st.id) || 'state');
    screens.push({ id, subpath: st.subpath || '.', steps: st.steps || [], state: true });
    stateIds.push(id);
  }
}

// Same position, same shape: equal stays; anything else becomes "<varies>".
const merge = (a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return { v: a, varies: false };
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) { let any = false; const v = a.map((x, i) => { const m = merge(x, b[i]); any = any || m.varies; return m.v; }); return { v, varies: any }; }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) && JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b))) {
    let any = false; const v = {};
    for (const k of Object.keys(a)) { const m = merge(a[k], b[k]); any = any || m.varies; v[k] = m.v; }
    return { v, varies: any };
  }
  return { v: '<varies>', varies: true };
};

for (const s of screens) {
  try {
    const a = await runSteps(ctx, s.steps, { subpath: s.subpath });
    const b = await runSteps(ctx, s.steps, { subpath: s.subpath });
    const m = merge(a.results, b.results);
    const r = { ...a, results: m.v };
    if (m.varies) volatile.push(s.id);
    runs.push({ id: s.id, subpath: s.subpath, steps: s.steps, result: r });
  } catch (e) { notCaptured.push(`screen ${s.id}: ${scrub(e.message).split('\n')[0]}`); }
}

// 2. Probes.
const notChecked = [];
const probes = await runProbes({ ctx, surface, runs, timings, notChecked });

// 3. Write the golden folder.
const byId = new Map(screens.map((s) => [s.id, s]));
for (const { id, result: r } of runs) {
  const s = byId.get(id);
  const dir = path.join(out, 'screens', id);
  write(path.join(dir, 'steps.json'), { subpath: s.subpath, steps: s.steps });
  write(path.join(dir, 'result.json'), scrub(JSON.stringify({ importError: r.importError, results: r.results, unhandled: r.unhandled, hung: r.hung, timedOut: r.timedOut, ms: r.ms, written: r.written.map(({ path: p, bytes, sha256 }) => ({ path: p, bytes, sha256 })) }, null, 2)));
  write(path.join(dir, 'stdout.txt'), scrub(r.stdout));
  write(path.join(dir, 'stderr.txt'), scrub(r.stderr));
  for (const n of ['stdout', 'stderr']) if (r.cut[n]) notCaptured.push(`${id}: ${n} was cut at 1 MB`);
  if (r.timedOut) notCaptured.push(`${id}: the run was stopped after the time limit`);
  for (const w of r.written) {
    if (w.text !== undefined) write(path.join(dir, 'out', w.path), scrub(w.text));
    else notCaptured.push(`${id}: written file ${w.path} (${w.bytes} bytes) is not text or too large; only its size and hash are kept`);
  }
  timings.push({ name: `${id}.ms`, value: r.ms, unit: 'ms' });
  for (const l of scrub(r.stderr).split('\n').filter(Boolean)) consoleLines.push(`[${id}] ${l}`);
}
if (ctx.buildMs !== null) timings.push({ name: 'build-ms', value: ctx.buildMs, unit: 'ms' });

// Declarations of the package, scrubbed (they are the contract; they hold no implementation).
const typesDir = path.join(out, 'types');
const copyDts = (d, rel = '') => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) copyDts(p, path.join(rel, e.name));
    else if (/\.d\.(m|c)?ts$/.test(e.name)) write(path.join(typesDir, rel, e.name), scrub(fs.readFileSync(p, 'utf8')));
  }
};
copyDts(ctx.entryDir);
const { rootDir, typeFiles, ...surfaceOut } = surface;
write(path.join(out, 'surface.json'), scrub(JSON.stringify(surfaceOut, null, 2)));

notCaptured.push('no screens or screenshots: library');
notCaptured.push(networkMode() === 'namespace'
  ? 'network is blocked with a network namespace for every run and not observed'
  : 'network is blocked through a dead proxy and not observed; network blocked only for code that honours proxy variables');
notCaptured.push(...surface.notes);
if (surface.cut.length) notCaptured.push(`${surface.cut.length} more exports found and not captured (cap ${MAX_SYMBOLS})`);
for (const c of callsSkipped) notCaptured.push(`${c.symbol}: no example call (${c.reason})`);
let appVersion = run.appVersion || surface.version || null;
write(path.join(out, 'manifest.json'), scrub(JSON.stringify({
  platform: 'library', appVersion,
  screens: runs.map(({ id, subpath, steps }) => ({ id, subpath, steps, ...(byId.get(id).state ? { state: true } : {}) })),
  states: stateIds, volatile, libraryFirst: surface.libraryFirst,
  blockedRequests: [],
  notCaptured: [...notCaptured, ...notChecked.map((r) => scrub(`${r.probe} ${r.route}: ${r.reason}`))],
}, null, 2)));
write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review library adapter', version: '1' }, entries: [] } });
write(path.join(out, 'coverage.json'), { caps: { maxSymbols: MAX_SYMBOLS }, screensReached: runs.map((r) => r.id), screensCut: surface.cut, callsSkipped, buttonsSkipped: [], harEntriesSkipped: 0 });
write(path.join(out, 'timings.json'), timings);
write(path.join(out, 'probes.json'), probes);
write(path.join(out, 'probes-not-checked.json'), notChecked);
write(path.join(out, 'console.log'), consoleLines.join('\n') + (consoleLines.length ? '\n' : ''));
console.log(`captured ${runs.length} screens, ${surface.symbols.length} symbols, ${probes.filter((p) => !p.passed).length} probe flags -> ${out}`);
process.exit(0);

// Fifteen checks for the library adapter, run against the fixture package in ./fixture. node test/run.mjs
// The known answers are in answers.json; only this file reads them. A planted problem the probes miss is printed as MISS and
// is not hidden or tuned away. A check fails only when the thing it protects is broken (a leak, a hang, a missing file, a false alarm on a clean screen).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(here, '..');
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const runModule = await import(pathToFileURL(path.join(adapter, 'run.mjs')).href);
const { prepare, runSteps, networkMode } = runModule;
const { readSurface, surfaceMissing } = await import(pathToFileURL(path.join(adapter, 'surface.mjs')).href);
const tsc = path.join(adapter, 'node_modules', 'typescript', 'bin', 'tsc');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-lib-test-')));
const results = [];
const note = (...a) => console.log('   ', ...a);
function check(n, name, ok, lines = []) {
  results.push({ n, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}`);
  for (const l of lines) note(l);
}

// ---- decoys: what the package must not see of this machine ----
const secret = 'secret-' + crypto.randomBytes(6).toString('hex');
const realHome = path.join(base, 'real-home');
fs.mkdirSync(realHome);
const TOKEN = 'tok_0123456789abcdef0123456789abcdef0123';

// A server on this machine's network address (not loopback). Anything that reaches it left the machine's allowed addresses.
let hits = 0;
const server = http.createServer((req, res) => { hits++; res.end('outside'); });
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const outside = lan ? `http://${lan.address}:${server.address().port}/` : 'http://192.0.2.1:9/';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const allFiles = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? allFiles(p, out) : out.push(p); } return out; };
const env = { ...process.env, HOME: realHome, USERPROFILE: realHome, RR_SECRET_PARENT: secret };
delete env.RR_PREPARED;
function runNode(script, argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [path.join(adapter, script), ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code, text, ms: Date.now() - t0 }));
  });
}
// A run folder with a work copy of a source folder (committed to git) and a run.json.
function makeRun(name, srcDir, runJson) {
  const dir = path.join(base, name);
  const work = path.join(dir, 'work');
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(srcDir, work, { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(runJson));
  return { dir, work, file, git };
}
// A tiny package written from files, for the edge cases.
function tiny(name, files, pkg) {
  const src = path.join(base, `src-${name}`);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name, version: '0.1.0', ...pkg }));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(src, f), c);
  return makeRun(name, src, { platform: 'library', language: 'node' });
}
const capture = async (r, extra = []) => { const g = path.join(r.dir, 'golden'); const c = await runNode('capture.mjs', ['--app', r.file, '--out', g, ...extra]); return { ...c, golden: g, manifest: readJson(path.join(g, 'manifest.json')) || { screens: [], notCaptured: [] }, surface: readJson(path.join(g, 'surface.json')) || { symbols: [] }, coverage: readJson(path.join(g, 'coverage.json')) || {}, probes: readJson(path.join(g, 'probes.json')) || [] }; };

try {
  console.log(`network mode: ${networkMode()}; fixture outside address: ${lan ? outside : 'none (no non-loopback address on this machine)'}`);
  const build = `"${process.execPath}" "${tsc}" -p .`;
  const main = makeRun('run-main', path.join(here, 'fixture'), { platform: 'library', language: 'node', build, env: { FIXTURE_TOKEN: TOKEN } });
  const golden = path.join(main.dir, 'golden');
  const cap = await runNode('capture.mjs', ['--app', main.file, '--out', golden, '--states', path.join(here, 'states.json')]);
  note(`capture exited ${cap.code} in ${Math.round(cap.ms / 1000)} s: ${cap.text.trim().split('\n').pop()}`);
  const manifest = readJson(path.join(golden, 'manifest.json')) || { screens: [] };
  const probes = readJson(path.join(golden, 'probes.json')) || [];
  const ids = manifest.screens.map((s) => s.id);
  process.env.RR_PREPARED = '1'; // the build was made by the capture
  const ctx = prepare(readJson(main.file), main.file);

  // 1
  {
    const bad = [];
    for (const f of ['manifest.json', 'network.har', 'timings.json', 'probes.json', 'probes-not-checked.json', 'console.log', 'coverage.json', 'surface.json']) if (!fs.existsSync(path.join(golden, f))) bad.push(`missing ${f}`);
    if (!fs.existsSync(path.join(golden, 'types', 'dist', 'index.d.ts'))) bad.push('types/dist/index.d.ts missing');
    const har = readJson(path.join(golden, 'network.har')); if (!har || !Array.isArray(har.log && har.log.entries)) bad.push('network.har is not a HAR');
    const tim = readJson(path.join(golden, 'timings.json'));
    if (!Array.isArray(tim) || tim.some((t) => !('name' in t && 'value' in t && 'unit' in t))) bad.push('timings.json is not a list of {name,value,unit}');
    else for (const n of ['build-ms', 'import-ms', 'dependency-count', 'add.ms']) if (!tim.some((t) => t.name === n)) bad.push(`timings.json has no ${n}`);
    const nc = readJson(path.join(golden, 'probes-not-checked.json')) || [];
    if (!nc.some((x) => x.probe === 'install-size')) bad.push('install-size (no node_modules here) is not listed as not checked');
    if (!Array.isArray(probes) || probes.some((p) => !('probe' in p && 'screen' in p && 'passed' in p && 'evidence' in p))) bad.push('probes.json is not a list of {probe,screen,passed,evidence}');
    if (manifest.platform !== 'library') bad.push(`manifest platform is "${manifest.platform}"`);
    if (!(manifest.notCaptured || []).some((x) => /no screens or screenshots/.test(x))) bad.push('notCaptured does not say there are no screens or screenshots');
    if (!(manifest.notCaptured || []).some((x) => /network/.test(x))) bad.push('notCaptured does not say how the network was blocked');
    for (const id of ids) for (const f of ['steps.json', 'result.json', 'stdout.txt', 'stderr.txt']) if (!fs.existsSync(path.join(golden, 'screens', id, f))) bad.push(`screens/${id}/${f} missing`);
    check(1, 'capture writes every contract file, and each screen its step and result files', cap.code === 0 && !bad.length, [...bad.slice(0, 10), `${ids.length} screens checked`]);
  }

  // 2
  {
    const lines = [];
    const surf = await readSurface(ctx);
    const names = surf.symbols.map((s) => s.name);
    const missing = answers.symbols.filter((n) => !names.includes(n));
    const counter = surf.symbols.find((s) => s.name === 'Counter');
    const loud = surf.symbols.find((s) => s.name === 'loud');
    const add = surf.symbols.find((s) => s.name === 'add');
    lines.push(`${surf.symbols.length} symbols in ${surf.entries.length} entries; missing: ${missing.join(', ') || 'none'}`);
    lines.push(`add: ${add && add.signature}; Counter kind: ${counter && counter.kind}; loud on subpath ${loud && loud.subpath}`);
    // a rebuild that dropped greet and changed add's parameter
    const reb = makeRun('run-rebuilt', path.join(here, 'fixture'), { platform: 'library', language: 'node', build });
    spawnSync(process.execPath, [tsc, '-p', '.'], { cwd: reb.work });
    const dts = path.join(reb.work, 'dist', 'index.d.ts');
    fs.writeFileSync(dts, fs.readFileSync(dts, 'utf8').replace(/export declare function greet[^\n]*\n/, '').replace('add(a: number, b: number): number', 'add(a: string): number'));
    const rsurf = await readSurface(prepare(readJson(reb.file), reb.file));
    const diff = surfaceMissing(surf, rsurf);
    lines.push(`surface-missing against a rebuild with greet removed and add changed: ${diff.map((d) => `${d.name} (${d.why})`).join(', ')}`);
    const same = surfaceMissing(surf, surf);
    check(2, 'the surface lists exports from package.json and the declarations (subpath, class), and surface-missing finds a removed and a changed export but nothing on itself',
      !missing.length && counter && counter.kind === 'class' && loud && loud.subpath === './noisy' && diff.some((d) => d.name === 'greet') && diff.some((d) => d.name === 'add' && /not satisfied/.test(d.why)) && !diff.some((d) => d.name === 'Counter') && same.length === 0, lines);
  }

  // 3
  {
    const lines = [];
    const flagged = probes.filter((p) => !p.passed);
    const isClean = (s) => answers.clean.some((c) => s === c || s.startsWith(c + '-'));
    for (const e of answers.problems) {
      const hit = flagged.find((p) => p.probe === e.probe && p.screen === e.screen);
      lines.push(hit ? `${e.id} flagged (${hit.probe} on ${hit.screen}): ${hit.evidence}` : `${e.id} MISS: ${e.what}. No ${e.probe} flag on ${e.screen}.`);
    }
    const ctl = flagged.filter((p) => isClean(p.screen));
    if (ctl.length) lines.push(`FALSE ALARM on a clean screen: ${ctl.map((p) => `${p.probe} on ${p.screen} (${p.evidence})`).join('; ')}`);
    else lines.push('clean screens (add, greet, counter, makeadder, makecounter, kindof, echovalues, kinds, counter-flow): nothing flagged');
    const extra = flagged.filter((p) => !answers.problems.some((e) => e.probe === p.probe && e.screen === p.screen) && !isClean(p.screen));
    if (extra.length) lines.push(`also flagged (not in the answers): ${extra.map((p) => `${p.probe} on ${p.screen}`).join('; ')}`);
    check(3, 'each planted problem flagged, clean exports not (misses are reported, not hidden)', !ctl.length && probes.length > 0, lines);
  }

  // 4
  {
    const lines = [];
    const r = await runSteps(ctx, [{ call: 'echoValues' }, { call: 'kindOf', args: [{ $: 'Date', v: '2020-01-01T00:00:00.000Z' }] }, { call: 'kindOf', args: [{ $: 'Map', v: [] }] }, { call: 'kindOf', args: [{ $: 'bigint', v: '7' }] }]);
    const v = (r.results[0] || {}).returned || {};
    const out = r.results.slice(1).map((x) => x.returned);
    lines.push(`returned tags: ${['d', 'm', 'b', 'n', 'e'].map((k) => v[k] && v[k].$).join(', ')}; arguments arrive as: ${out.join(', ')}`);
    check(4, 'a Date, Map, bigint, NaN and Error survive the round trip as tagged values, and tagged arguments arrive as the real type',
      v.d && v.d.$ === 'Date' && v.m && v.m.$ === 'Map' && v.b && v.b.$ === 'bigint' && v.b.v === '5' && v.n && v.n.$ === 'number' && v.n.v === 'NaN' && v.e && v.e.$ === 'Error' && v.e.message === 'plain' && out.join() === 'Date,Map,bigint', lines);
  }

  // 5
  {
    const r = await runSteps(ctx, [{ call: 'writeHome' }, { call: 'readEnv', args: ['RR_SECRET_PARENT'] }, { call: 'readEnv', args: ['HOME'] }]);
    const inTempHome = r.written.some((w) => w.path === 'home/.fixture.json');
    const inReal = fs.existsSync(path.join(realHome, '.fixture.json'));
    const dirty = main.git('status', '--porcelain').stdout.trim();
    const leaks = [];
    for (const f of allFiles(golden)) { const t = fs.readFileSync(f, 'utf8'); for (const [what, v] of [['parent secret', secret], ['real home path', realHome]]) if (t.includes(v)) leaks.push(`${what} appears in ${path.relative(golden, f)}`); }
    const seen = r.results[1] && r.results[1].returned;
    check(5, 'the package ran with an isolated home: its file landed in the temp home, nothing in the real home or the work copy changed, no parent secret reached it or the golden',
      inTempHome && !inReal && !dirty && seen === null && !leaks.length, [...leaks, `file written in the temp home: ${inTempHome}; in the real home: ${inReal}; work copy: ${dirty ? `changed (${dirty})` : 'clean'}; parent secret seen by the package: ${seen !== null}`]);
  }

  // 6
  {
    const before = hits;
    const r = await runSteps(ctx, [{ call: 'fetchOut', args: [outside] }]);
    const reached = hits - before;
    const major = Number(process.versions.node.split('.')[0]);
    const ok = r.results[0] && r.results[0].ok === false && (!lan || reached === 0) && (networkMode() === 'namespace' || major >= 24) && r.mode === networkMode();
    check(6, 'an outside fetch fails and nothing is reached', ok, [`mode: ${r.mode}; node ${process.versions.node}`, lan ? `requests that reached the outside server: ${reached}` : 'hit count not measured: no non-loopback address here']);
  }

  // 7
  {
    const files = allFiles(golden);
    const found = files.filter((f) => fs.readFileSync(f, 'utf8').includes(TOKEN)).map((f) => path.relative(golden, f));
    const res = fs.readFileSync(path.join(golden, 'screens', 'token', 'result.json'), 'utf8');
    check(7, 'a token-like value in a return value is scrubbed in the golden', !found.length && res.includes('[redacted]'), [found.length ? `token still in: ${found.join(', ')}` : 'the token appears in no golden file', `token screen result: ${res.replace(/\s+/g, ' ').slice(0, 160)}`]);
  }

  // 8
  {
    const dir = path.join(base, 'parity');
    const tests = path.join(dir, 'tests');
    fs.mkdirSync(tests, { recursive: true });
    const head = `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const { prepare, runSteps } = await import(pathToFileURL(process.env.LIB_MODULE).href);
const ctx = prepare(JSON.parse(fs.readFileSync(process.env.APP_RUN, 'utf8')), process.env.APP_RUN);
`;
    fs.writeFileSync(path.join(tests, 'F-001.test.mjs'), head + `test('adds', async () => { const r = await runSteps(ctx, [{ call: 'add', args: [2, 3] }]); assert.equal(r.results[0].returned, 5, 'expected add(2, 3) to be 5'); });\n`);
    fs.writeFileSync(path.join(tests, 'F-002.test.mjs'), head + `test('adds to six', async () => { const r = await runSteps(ctx, [{ call: 'add', args: [2, 3] }]); assert.equal(r.results[0].returned, 6, 'expected add(2, 3) to be 6'); });\n`);
    const out = path.join(dir, 'results.json');
    const p = await runNode('parity.mjs', ['--app', main.file, '--tests', tests, '--out', out]);
    const by = Object.fromEntries((readJson(out) || []).map((x) => [x.feature, x]));
    // the rebuild: the same package with one built function changed
    const project = path.join(main.dir, 'project');
    fs.cpSync(main.work, project, { recursive: true });
    const js = path.join(project, 'dist', 'index.js');
    fs.writeFileSync(js, fs.readFileSync(js, 'utf8').replace('return a + b; }\n/**\n * Returns', 'return a + b + 1; }\n/**\n * Returns').replace(/export function add\(a, b\) \{ return a \+ b; \}/, 'export function add(a, b) { return a + b + 1; }'));
    fs.writeFileSync(path.join(project, 'rebuild-run.json'), JSON.stringify({ platform: 'library', language: 'node', dir: '.', entry: '.' }));
    const out2 = path.join(dir, 'results-rebuild.json');
    const p2 = await runNode('parity.mjs', ['--app', path.join(project, 'rebuild-run.json'), '--tests', tests, '--out', out2]);
    const by2 = Object.fromEntries((readJson(out2) || []).map((x) => [x.feature, x]));
    check(8, 'parity on two tests gives one pass and one fail on the original, and the changed rebuild fails the one that passed',
      p.code === 0 && by['F-001'] && by['F-001'].passed === true && by['F-002'] && by['F-002'].passed === false && /to be 6/.test(by['F-002'].detail) && p2.code === 0 && by2['F-001'] && by2['F-001'].passed === false,
      [p.text.trim().split('\n').pop(), p2.text.trim().split('\n').pop(), `F-002: ${by['F-002'] ? by['F-002'].detail.split('\n').find((l) => /expected|to be 6/.test(l)) || 'no message' : 'missing'}`]);
  }

  // 9
  {
    const lines = [];
    const held = await runSteps(ctx, [{ call: 'hold', args: [1] }], { timeoutMs: 1500 });
    const pid = Number((/child (\d+)/.exec(held.stdout) || [])[1]);
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    lines.push(`timed out: ${held.timedOut}; the child (a process the call left running) is ${alive ? 'STILL RUNNING' : 'gone'}`);
    if (alive) try { process.kill(pid, 'SIGKILL'); } catch {}
    let winRefused = false;
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { prepare({ platform: 'library' }, path.join(base, 'nowhere', 'run.json')); } catch (e) { winRefused = /not supported on Windows/.test(e.message); } finally { Object.defineProperty(process, 'platform', real); }
    lines.push(`Windows refused with a reason: ${winRefused}`);
    check(9, 'a timeout kills a hung call and the child it left running; Windows is refused', held.timedOut && pid > 0 && !alive && winRefused, lines);
  }

  // 10: types missing, JS only
  {
    const r = tiny('jsonly', { 'index.js': 'export function hello(n) { return "hi " + n; }\nexport const answer = 42;\n' }, { type: 'module', main: 'index.js' });
    const c = await capture(r);
    const names = c.surface.symbols.map((s) => s.name);
    check(10, 'edge: a package with no type declarations is listed from a real import, kind unknown, with a note', c.code === 0 && names.includes('hello') && names.includes('answer') && c.surface.symbols.every((s) => s.kind === 'unknown') && c.manifest.notCaptured.some((x) => /no type declarations/.test(x)), [`symbols: ${c.surface.symbols.map((s) => `${s.name}:${s.kind}`).join(', ')}`, `note: ${c.manifest.notCaptured.find((x) => /no type declarations/.test(x))}`]);
  }

  // 11: default export only
  {
    const r = tiny('cjsdefault', { 'index.js': 'module.exports = function shout(s) { return String(s).toUpperCase(); };\n', 'index.d.ts': 'declare function shout(s: string): string;\nexport = shout;\n' }, { main: 'index.js', types: 'index.d.ts' });
    const states = path.join(r.dir, 'states.json');
    fs.writeFileSync(states, JSON.stringify([{ id: 'shout-abc', steps: [{ call: 'default', args: ['abc'] }] }]));
    const c = await capture(r, ['--states', states]);
    const d = c.surface.symbols.find((s) => s.name === 'default');
    const stateRes = readJson(path.join(c.golden, 'screens', 'shout-abc', 'result.json')) || { results: [] };
    const smoke = readJson(path.join(c.golden, 'screens', 'default', 'result.json')) || { results: [] };
    check(11, 'edge: a package whose only export is the default (module.exports or export default) is one symbol "default", called through the harness', c.code === 0 && d && d.kind === 'function' && stateRes.results[0] && stateRes.results[0].returned === 'ABC' && smoke.results[0] && smoke.results[0].ok === true, [`symbols: ${c.surface.symbols.map((s) => `${s.name}:${s.kind}`).join(', ')}`, `default('abc') returned ${JSON.stringify(stateRes.results[0] && stateRes.results[0].returned)}`]);
  }

  // 12: a function taking a stream, socket or file handle
  {
    const r = tiny('streamy', { 'index.js': 'export function consume(src) { return src.read(); }\nexport function plain(n) { return n; }\n', 'index.d.ts': 'export interface Readable { read(): string }\nexport declare function consume(src: Readable): string;\nexport declare function plain(n: number): number;\n' }, { type: 'module', main: 'index.js', types: 'index.d.ts' });
    const c = await capture(r);
    const sid = c.manifest.screens.map((s) => s.id);
    const skipped = (c.coverage.callsSkipped || []).map((x) => x.symbol);
    check(12, 'edge: a function taking a stream, socket or file handle is listed, gets no generated example, and is named in callsSkipped', c.code === 0 && c.surface.symbols.some((s) => s.name === 'consume') && !sid.some((x) => x.startsWith('consume')) && skipped.some((x) => x.endsWith(':consume')) && sid.includes('plain'), [`screens: ${sid.join(', ')}`, `callsSkipped: ${skipped.join(', ')}`]);
  }

  // 13: 1,500 exports
  {
    const js = Array.from({ length: 1500 }, (_, i) => `export const c${i} = ${i};`).join('\n') + '\n';
    const dts = Array.from({ length: 1500 }, (_, i) => `export declare const c${i}: number;`).join('\n') + '\n';
    const r = tiny('many', { 'index.js': js, 'index.d.ts': dts }, { type: 'module', main: 'index.js', types: 'index.d.ts' });
    const c = await capture(r);
    check(13, 'edge: 1,500 exports are capped at 200 symbols and the rest are listed as cut', c.code === 0 && c.surface.symbols.length === 200 && (c.coverage.screensCut || []).length === 1300 && c.manifest.notCaptured.some((x) => /1300 more exports/.test(x)), [`symbols kept: ${c.surface.symbols.length}; cut: ${(c.coverage.screensCut || []).length}`]);
  }

  // 14: bin and library together
  {
    const r = tiny('both', { 'index.js': 'export const x = 1;\n', 'index.d.ts': 'export declare const x: number;\n', 'cli.js': '#!/usr/bin/env node\nconsole.log("hi")\n' }, { type: 'module', main: 'index.js', types: 'index.d.ts', bin: { both: 'cli.js' } });
    const c = await capture(r);
    check(14, 'edge: a package with both a bin and a library entry records that the CLI comes first and the library is a second run', c.code === 0 && c.surface.libraryFirst === false && !!c.surface.bin && c.manifest.libraryFirst === false && c.manifest.notCaptured.some((x) => /bin/.test(x)) && c.surface.symbols.some((s) => s.name === 'x') && (await readSurface(ctx)).libraryFirst === true, [`libraryFirst with a bin: ${c.surface.libraryFirst}; without: true`, `note: ${c.manifest.notCaptured.find((x) => /bin/.test(x))}`]);
  }

  // 15: a call that returns a function or an instance
  {
    const fn = readJson(path.join(golden, 'screens', 'makeadder', 'result.json')) || { results: [] };
    const inst = readJson(path.join(golden, 'screens', 'makecounter', 'result.json')) || { results: [] };
    const f = fn.results[0] && fn.results[0].returned, i = inst.results[0] && inst.results[0].returned;
    const text = JSON.stringify([f, i]);
    check(15, 'edge: a call that returns a function or a class instance is recorded as a tag (fn, or the class name), never as a serialized body', f && f.$ === 'fn' && i && i.$ === 'instance' && i.class === 'Counter' && !/=>|function|return/.test(text), [`returned: ${text}`]);
  }
} finally {
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? '; failed: ' + failed.map((r) => r.n).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);

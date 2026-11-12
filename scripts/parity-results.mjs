// Pass or fail decisions for the Parity phase, in code, no dependencies.
//   node parity-results.mjs wrong  <features.md> <results.json>   prints the count and the IDs of wrong tests
//   node parity-results.mjs settle <parDir> <features.md>         moves wrong and flaky tests to removed/, notes them in untested.md, rewrites original.json
//   node parity-results.mjs merge  <parDir> <features.md>         writes parity.json
//   node parity-results.mjs loop   <parDir> <features.md> <runDir> records the round, writes failures.md, prints {action, reason, failing}
//   node parity-results.mjs prep   <parDir> <rebuild-run.json>    clears the last rebuild result and error, gives the rebuild a free port
//   node parity-results.mjs run-error <parDir> <longDir> <name> [state]   writes run-error.txt from that long run's exit code and log tail (the rebuild would not start)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { readPlan } from './size.mjs';
import { tryEmit } from './events.mjs';

// Map of feature ID to keep or defect, from lines that start with "F-xxx keep" or "F-xxx defect".
export function kinds(featuresMd) {
  const out = {};
  for (const line of featuresMd.split('\n')) {
    if (!/^\W*F-\d+/i.test(line)) continue;
    const m = line.match(/^\W*(F-\d+)\W+(keep|defect)\b/i);
    if (!m) throw new Error(`feature line has no keep or defect: ${line.slice(0, 80)}`);
    out[m[1].toUpperCase()] = m[2].toLowerCase();
  }
  return out;
}

// IDs of keep tests that failed and defect tests that passed.
export function wrongTests(results, kindMap) {
  return results.filter((r) => (kindMap[r.feature] === 'keep' && !r.passed) || (kindMap[r.feature] === 'defect' && r.passed)).map((r) => r.feature);
}

export const MAX_ROUNDS = 5;
const NO_RESULT = 'no result for this feature';
export const LOOP_USD = 50; // the floor; a big app gets more from size.json (plan.loopUsd)

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export function settle(parDir, featuresMd) {
  const kindMap = kinds(fs.readFileSync(featuresMd, 'utf8'));
  const a = readJson(path.join(parDir, 'original.json')), b = readJson(path.join(parDir, 'original-2.json'));
  const bBy = Object.fromEntries(b.map((r) => [r.feature, r]));
  const wrong = new Set([...wrongTests(a, kindMap), ...wrongTests(b, kindMap)]);
  const flaky = new Set(a.filter((r) => bBy[r.feature] && bBy[r.feature].passed !== r.passed).map((r) => r.feature));
  const notes = [];
  for (const id of [...new Set([...wrong, ...flaky])].sort()) {
    const file = path.join(parDir, 'tests', `${id}.test.mjs`);
    if (fs.existsSync(file)) { fs.mkdirSync(path.join(parDir, 'removed'), { recursive: true }); fs.renameSync(file, path.join(parDir, 'removed', `${id}.test.mjs`)); }
    notes.push(flaky.has(id) ? `${id}: flaky, its result differed between two runs on the original` : `${id}: wrong test, ${kindMap[id] === 'keep' ? 'a keep test failed' : 'a defect test passed'} on the original after the fix rounds`);
  }
  if (notes.length) fs.appendFileSync(path.join(parDir, 'untested.md'), notes.join('\n') + '\n');
  const gone = new Set([...wrong, ...flaky]);
  fs.writeFileSync(path.join(parDir, 'original.json'), JSON.stringify(a.filter((r) => !gone.has(r.feature)), null, 2));
  return notes;
}

export function merge(parDir, featuresMd) {
  const kindMap = kinds(fs.readFileSync(featuresMd, 'utf8'));
  const load = (n) => { const f = path.join(parDir, n); return fs.existsSync(f) ? Object.fromEntries(readJson(f).map((r) => [r.feature, r.passed ? 'pass' : 'fail'])) : {}; };
  const orig = load('original.json'), reb = load('rebuild.json');
  const un = {};
  const uf = path.join(parDir, 'untested.md');
  if (fs.existsSync(uf)) for (const l of fs.readFileSync(uf, 'utf8').split('\n')) { const m = l.match(/^\W*(F-\d+)\W*:\s*(.*)$/i); if (m) un[m[1].toUpperCase()] = m[2]; }
  const out = Object.keys(kindMap).sort().map((feature) => {
    if (un[feature] !== undefined) return { feature, kind: kindMap[feature], original: 'not run', rebuild: 'not run', note: un[feature] };
    const original = orig[feature] || 'not run', rebuild = reb[feature] || 'not run';
    const note = original !== 'not run' && rebuild !== 'not run' && original !== rebuild ? `${original} on the original, ${rebuild} on the rebuild` : '';
    return { feature, kind: kindMap[feature], original, rebuild, note };
  });
  fs.writeFileSync(path.join(parDir, 'parity.json'), JSON.stringify(out, null, 2));
  return out;
}

// IDs listed in untested.md.
function untestedIds(parDir) {
  const ids = new Set();
  const uf = path.join(parDir, 'untested.md');
  if (fs.existsSync(uf)) for (const l of fs.readFileSync(uf, 'utf8').split('\n')) { const m = l.match(/^\W*(F-\d+)\W*:/i); if (m) ids.add(m[1].toUpperCase()); }
  return ids;
}

// Every tested feature whose result on the rebuild is not a pass (a missing result counts), keep and defect alike.
export function failing(parDir, featuresMd) {
  const kindMap = kinds(fs.readFileSync(featuresMd, 'utf8'));
  const un = untestedIds(parDir);
  const rf = path.join(parDir, 'rebuild.json');
  const by = fs.existsSync(rf) ? Object.fromEntries(readJson(rf).map((r) => [r.feature, r])) : {};
  return Object.keys(kindMap).sort().filter((id) => !un.has(id)).filter((id) => !(by[id] && by[id].passed))
    .map((id) => ({ feature: id, kind: kindMap[id], detail: by[id] ? String(by[id].detail || '') : NO_RESULT }));
}

// A failure message without stack lines, quoted test source, or absolute file paths, at most 15 lines.
export function cleanDetail(text, parDir) {
  let t = String(text);
  if (parDir) t = t.split(parDir).join('<path>');
  const kept = [];
  let blanks = 0; // blank lines left before the source node quotes after "The expression evaluated to a falsy value:" ends
  for (const l of t.split('\n')) {
    if (/The expression evaluated to a falsy value/.test(l)) { blanks = 2; continue; }
    if (blanks > 0) { if (l.trim() === '') blanks--; continue; }
    if (/^\s*at\s/.test(l) || /^\s*(generatedMessage|code|operator):/.test(l) || /^\s*test at\s/.test(l) || /^\s*assert(\.\w+)?\(/.test(l)) continue;
    kept.push(l);
  }
  return kept
    .map((l) => l.replace(/file:\/\/\/?[^\s)'"]+/g, '<path>').replace(/(?<!\w)[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/])*[^\s\\/:*?"<>|]*/g, '<path>').replace(/(?<![\w:/.])(?:\/[\w.@~+-]+){2,}\/?/g, '<path>'))
    .slice(0, 15).join('\n');
}

// Node's own text for assert.ok(value) with no message: the test said nothing about what it expected or saw.
function noMessage(text) { return /The expression evaluated to a falsy value/.test(String(text)); }

// Total cost of the build children, and the highest build number, from <runDir>/rebuild/build-*.result.json.
export function readCost(runDir) {
  const dir = path.join(runDir, 'rebuild');
  let spent = 0, build = 0;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^build-(\d+)\.result\.json$/);
    if (!m) continue;
    build = Math.max(build, Number(m[1]));
    try { spent += Number(readJson(path.join(dir, f)).costUsd) || 0; } catch { /* unreadable result counts as 0 */ }
  }
  return { spent, build };
}

// Try to listen on host:port (0 = any). Resolves the port, or null when this host cannot bind there (address in use, no such address).
const tryBind = (host, port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(null));
  server.listen(port, host, () => { const p = server.address().port; server.close(() => resolve(p)); });
});

// A free port on the host the address names. Plain "localhost" can mean 127.0.0.1 or ::1 (the app binds the first one the system
// resolves), so the port is found by listening on "localhost" itself and then also proven free on both loopback addresses
// (::1 is skipped when this machine has no IPv6 loopback). Any other host is probed as written; a host this machine cannot bind
// (a remote name) is an error, because a free port cannot be proven there.
async function freePort(host) {
  const h = host.replace(/^\[|\]$/g, '');
  for (let i = 0; i < 20; i++) {
    const port = await tryBind(h, 0);
    if (port === null) throw new Error(`cannot find a free port on host ${host}`);
    if (h.toLowerCase() !== 'localhost') return port;
    const v4 = await tryBind('127.0.0.1', port);
    const v6 = await tryBind('::1', port);
    const v6Missing = v6 === null && (await tryBind('::1', 0)) === null;
    if (v4 !== null && (v6 !== null || v6Missing)) return port;
  }
  throw new Error(`cannot find a port that is free on every loopback address of ${host}`);
}

// Splits "scheme://[user@]host[:port]rest" without touching any character: head, host, port text (or null), rest.
function splitAddress(address) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/.exec(address);
  if (!m) return null;
  const at = m[2].lastIndexOf('@');
  const userinfo = at >= 0 ? m[2].slice(0, at + 1) : '';
  const hp = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(m[2].slice(at + 1));
  if (!hp || !hp[1]) return null;
  return { head: m[1] + userinfo, host: hp[1], port: hp[2] ?? null, rest: m[3] };
}

// Before a suite run on the rebuild: drop the last result and error, and give a web rebuild a free port (only the port in "address" changes:
// the original text is edited, never reparsed, so scheme and host case, path, query, %-encoding and ".." stay as given).
// Throws with the reason when rebuild-run.json cannot be read or written: that is a phase error, not "the rebuild would not start".
export async function prep(parDir, rbFile) {
  for (const n of ['rebuild.json', 'run-error.txt']) fs.rmSync(path.join(parDir, n), { force: true });
  let run;
  try {
    run = readJson(rbFile);
    if (run === null || typeof run !== 'object' || Array.isArray(run)) throw new Error('it is not a JSON object');
  } catch (e) { throw new Error(`cannot read ${rbFile}: ${e.message}`); }
  if (typeof run.address !== 'string' || !run.address) return { port: null };
  const parts = splitAddress(run.address);
  try { new URL(run.address); } catch { throw new Error(`the address in ${rbFile} is not a URL with host and port (like http://localhost:3000): ${run.address}`); }
  if (!parts) throw new Error(`the address in ${rbFile} is not a URL with host and port (like http://localhost:3000): ${run.address}`);
  const port = await freePort(parts.host);
  run.address = `${parts.head}${parts.host}:${port}${parts.rest}`;
  try { fs.writeFileSync(rbFile, JSON.stringify(run, null, 2) + '\n'); } catch (e) { throw new Error(`cannot write ${rbFile}: ${e.message}`); }
  return { port };
}

// The reason is read from the long-run files (<name>.exit, last 20 lines of <name>.log), never passed on a command line,
// so log text cannot reach a shell.
// state is the longRun state word from the workflow (exited, lost, could not start, ...), never log text.
export function runErrorText(longDir, name, state = 'exited') {
  let code = null, tail = '';
  try { const t = fs.readFileSync(path.join(longDir, `${name}.exit`), 'utf8').trim(); if (/^-?\d+$/.test(t)) code = Number(t); } catch {}
  try {
    const f = path.join(longDir, `${name}.log`), size = fs.statSync(f).size, len = Math.min(size, 4000), buf = Buffer.alloc(len), fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    tail = buf.toString('utf8').split('\n').slice(-20).join('\n').trim();
  } catch {}
  const head = state !== 'exited' ? String(state) : code === null || Number.isNaN(code) ? 'the command was lost' : `exit code ${code}`;
  return tail ? `${head}: ${tail}` : `${head} (no output)`;
}

export function writeRunError(parDir, text) {
  fs.mkdirSync(parDir, { recursive: true });
  fs.writeFileSync(path.join(parDir, 'run-error.txt'), String(text).trim() ? String(text) : 'the rebuild did not start (no output)');
}

export function loop(parDir, featuresMd, runDir) {
  const { spent, build } = readCost(runDir);
  const errFile = path.join(parDir, 'run-error.txt');
  let fails;
  if (fs.existsSync(errFile)) {
    const un = untestedIds(parDir), err = fs.readFileSync(errFile, 'utf8');
    fails = Object.entries(kinds(fs.readFileSync(featuresMd, 'utf8'))).filter(([id]) => !un.has(id)).sort()
      .map(([feature, kind]) => ({ feature, kind, detail: err }));
  } else fails = failing(parDir, featuresMd);
  const rf = path.join(parDir, 'rounds.json');
  const rounds = fs.existsSync(rf) ? readJson(rf) : [];
  rounds.push({ round: rounds.length + 1, build, failing: fails.map((f) => f.feature), costUsd: spent });
  fs.writeFileSync(rf, JSON.stringify(rounds, null, 2));
  fs.writeFileSync(path.join(parDir, 'failures.md'), fails.map((f) => `## ${f.feature} (${f.kind})\n${noMessage(f.detail) ? `The test gave no message for ${f.feature}; read its text in features.md.\n` : ''}${cleanDetail(f.detail, parDir)}\n`).join('\n'));
  const counts = rounds.map((r) => r.failing.length);
  // The suite did not run: no run error, yet every failing feature has no result at all (#143).
  const suiteDidNotRun = !fs.existsSync(errFile) && fails.length > 0 && fails.every((f) => f.detail === NO_RESULT);
  let out;
  if (!fails.length) out = { action: 'done', reason: 'all tested features pass' };
  else if (suiteDidNotRun) out = { action: 'stop', reason: 'suite did not run' };
  else if (counts.length >= 2 && counts[counts.length - 1] >= Math.min(...counts.slice(0, -1))) out = { action: 'stop', reason: 'no progress' };
  else if (spent >= readPlan(runDir).loopUsd) out = { action: 'stop', reason: 'budget' };
  else if (rounds.length >= MAX_ROUNDS) out = { action: 'stop', reason: 'rounds' };
  else out = { action: 'build', reason: 'failures go back to the builder' };
  out.failing = fails.map((f) => f.feature);
  if (out.action === 'stop') {
    const bestRound = rounds.reduce((b, r) => (r.failing.length <= b.failing.length ? r : b));
    const rb = path.join(runDir, 'rebuild'), from = (n) => path.join(rb, `project-from-build-${n}`);
    if (bestRound.build !== build && fs.existsSync(from(bestRound.build))) {
      const proj = path.join(runDir, 'project');
      fs.rmSync(from(build), { recursive: true, force: true });
      fs.renameSync(proj, from(build));
      fs.renameSync(from(bestRound.build), proj);
      out.restored = bestRound.build;
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, x, y, z] = process.argv.slice(2);
  if (cmd === 'wrong') {
    const ids = wrongTests(readJson(y), kinds(fs.readFileSync(x, 'utf8')));
    console.log(`${ids.length}${ids.length ? ' ' + ids.join(' ') : ''}`);
  } else if (cmd === 'settle') {
    const n = settle(x, y);
    console.log(`moved ${n.length}${n.length ? '\n' + n.join('\n') : ''}`);
    tryEmit(path.resolve(x, '..'), { kind: 'decision', what: 'settle', choice: `moved ${n.length}`, reason: n.length ? `to removed/: ${n.join(' ')}` : 'no test moved' });
  } else if (cmd === 'merge') {
    console.log(`parity.json: ${merge(x, y).length} features`);
  } else if (cmd === 'loop') {
    const d = loop(x, y, z);
    // restored is always printed (0 = nothing restored): the workflow reruns the suite on a restored build, and a field a relaying agent can drop must not decide that (#130).
    console.log(JSON.stringify({ ...d, restored: d.restored || 0 }));
    tryEmit(path.resolve(z), { kind: 'decision', what: 'loop', choice: d.action, reason: `${d.reason}; failing ${Array.isArray(d.failing) ? d.failing.length : d.failing}` });
  } else if (cmd === 'prep') {
    try { console.log(JSON.stringify(await prep(x, y))); } catch (e) { console.error(e.message); process.exit(1); }
  } else if (cmd === 'run-error') {
    writeRunError(x, runErrorText(y, z, process.argv[6] || 'exited'));
    const f = path.join(x, 'run-error.txt');
    if (!fs.existsSync(f)) { console.error(`run-error.txt was not written in ${x}`); process.exit(1); }
    console.log(`run-error written ${fs.statSync(f).size} bytes`);
  } else { console.error('usage: parity-results.mjs wrong|settle|merge|loop|prep|run-error ...'); process.exit(2); }
}

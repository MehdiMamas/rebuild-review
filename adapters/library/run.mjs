// Library adapter: call a package's exported functions in an isolated child process.
// run.json: { platform: "library", language: "node", dir?, install?, build?, entry, env? }   entry: the package folder (default ".") whose package.json names its exports
// As a module: const ctx = prepare(run, runFile); const r = await runSteps(ctx, steps, { subpath }).
// As a command: node run.mjs --app run.json -- '<steps json>'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { networkMode, OUTPUT_CAP, TEXT_FILE_CAP } from '../cli/run.mjs';

export { networkMode };
const ENV_ALLOW = ['PATH', 'LANG', 'TMPDIR', 'TEMP', 'SystemRoot'];
const DEAD_PROXY = '127.0.0.1:9';
const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harness.mjs');
const HANG_MS = 5000;

const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p); } return out; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Returns { base, workDir, entryDir }. dir and entry stay inside the folder holding the work copy.
export function locate(run, runFile) {
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  if (run.entry && path.isAbsolute(run.entry)) throw new Error(`run.json "entry" must be relative, got ${run.entry}`);
  const base = path.basename(runFile) === 'rebuild-run.json' ? path.dirname(runFile) : path.join(path.dirname(runFile), 'work');
  const workDir = path.resolve(base, run.dir || '.');
  if (!inside(base, workDir)) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  const entryDir = path.resolve(workDir, run.entry || '.');
  if (!inside(base, entryDir)) throw new Error(`run.json "entry" must stay inside ${base}, got ${run.entry}`);
  return { base, workDir, entryDir };
}

const prepared = new Map();
// Install and build once (RR_PREPARED=1 skips them).
export function prepare(run, runFile) {
  if (process.platform === 'win32') throw new Error('library adapter: process-group kill is not supported on Windows');
  const key = path.resolve(runFile);
  if (prepared.has(key)) return prepared.get(key);
  const { workDir, entryDir } = locate(run, key);
  let buildMs = null;
  if (process.env.RR_PREPARED !== '1') {
    if (run.install) execSync(run.install, { cwd: workDir, stdio: 'inherit' });
    if (run.build) { const t = Date.now(); execSync(run.build, { cwd: workDir, stdio: 'inherit' }); buildMs = Date.now() - t; }
  }
  const ctx = { run, runFile: key, workDir, entryDir, buildMs };
  prepared.set(key, ctx);
  return ctx;
}

// Where an export subpath points at run time ("." or "./sub"): the file the package.json maps it to.
export function entryFile(ctx, subpath = '.') {
  const pkg = JSON.parse(fs.readFileSync(path.join(ctx.entryDir, 'package.json'), 'utf8'));
  let t;
  if (pkg.exports !== undefined) {
    const ex = typeof pkg.exports === 'string' || Array.isArray(pkg.exports) || !Object.keys(pkg.exports).some((k) => k.startsWith('.')) ? { '.': pkg.exports } : pkg.exports;
    t = ex[subpath];
  } else if (subpath === '.') t = pkg.main || 'index.js';
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) { for (const x of v) { const r = pick(x); if (r) return r; } return null; }
    if (v && typeof v === 'object') for (const k of ['import', 'node', 'default', 'require']) if (k in v) { const r = pick(v[k]); if (r) return r; }
    return null;
  };
  const rel = pick(t);
  if (!rel) throw new Error(`package has no export "${subpath}"`);
  const file = path.resolve(ctx.entryDir, rel);
  if (!inside(ctx.entryDir, file)) throw new Error(`export "${subpath}" points outside the package`);
  return file;
}

// steps: [{ call, args } | { new, as, args } | { get } | { list: true }]. Returns
// { importMs, importError, results: [{ ok, returned | threw, callbacks? }], unhandled, code, signal, stdout, stderr, cut, written, ms, timedOut, hung, mode }.
export async function runSteps(ctx, steps, { subpath = '.', timeoutMs = 30000, env = {}, files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.RR_TMP_PARENT || os.tmpdir(), 'rr-lib-'));
  const cwd = path.join(root, 'cwd'), home = path.join(root, 'home'), io = path.join(root, 'io');
  fs.mkdirSync(cwd); fs.mkdirSync(home); fs.mkdirSync(io);
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.resolve(cwd, rel);
      if (!inside(cwd, p) || p === cwd) throw new Error(`file path must stay inside the working folder: ${rel}`);
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content);
    }
    const seed = new Map(walk(cwd).map((p) => [p, sha(fs.readFileSync(p))]));
    const stepsFile = path.join(io, 'steps.json'), resultFile = path.join(io, 'result.json');
    fs.writeFileSync(stepsFile, JSON.stringify(steps));
    const e = {};
    for (const k of ENV_ALLOW) if (process.env[k] !== undefined) e[k] = process.env[k];
    for (const k of Object.keys(process.env)) if (/^LC_/.test(k)) e[k] = process.env[k];
    Object.assign(e, ctx.run.env || {}, env);
    const proxy = `http://${DEAD_PROXY}`;
    Object.assign(e, {
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
      NODE_USE_ENV_PROXY: '1', TERM: 'dumb', CI: '1',
    });
    delete e.NO_COLOR; delete e.NO_PROXY; delete e.no_proxy;
    const mode = networkMode();
    let file = process.execPath, argv = [HARNESS, entryFile(ctx, subpath), stepsFile, resultFile];
    if (mode === 'namespace') { argv = ['--user', '--net', '--map-root-user', '--', file, ...argv]; file = 'unshare'; }

    const t0 = Date.now();
    const child = spawn(file, argv, { cwd, env: e, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { stdout: [], stderr: [] }, size = { stdout: 0, stderr: 0 }, cut = { stdout: false, stderr: false };
    const take = (name) => (d) => {
      if (size[name] >= OUTPUT_CAP) { cut[name] = true; return; }
      const room = OUTPUT_CAP - size[name];
      if (d.length > room) { cut[name] = true; d = d.subarray(0, room); }
      size[name] += d.length; out[name].push(d);
    };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));

    const state = await new Promise((resolve) => {
      let done = false, code = null, signal = null, timedOut = false, hung = false, error, ms = 0, graceTimer, hangTimer, poll;
      const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(hangTimer); clearInterval(poll);
        killGroup();
        child.stdout.destroy(); child.stderr.destroy();
        resolve({ code, signal, timedOut, hung, error, ms });
      };
      // The harness writes its result when every step is done; a process still alive HANG_MS later has a timer, socket or child holding it open.
      poll = setInterval(() => {
        if (hangTimer || !fs.existsSync(resultFile)) return;
        hangTimer = setTimeout(() => { hung = true; ms = Date.now() - t0; killGroup(); }, HANG_MS);
      }, 50);
      child.on('error', (err) => { error = err.message; ms = Date.now() - t0; finish(); });
      child.on('exit', (c, s) => { code = c; signal = s; if (!hung) ms = Date.now() - t0; graceTimer = setTimeout(finish, 200); });
      child.on('close', finish);
    });

    const text = (name) => {
      const buf = Buffer.concat(out[name]);
      if (isUtf8(cut[name] ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf)) return buf.toString('utf8');
      return `[binary ${buf.length} bytes]`;
    };
    let res = { importMs: null, importError: null, results: [], unhandled: [] };
    try { res = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* no result: the process died first */ }
    const written = [];
    for (const p of [...walk(cwd), ...walk(home)]) {
      const buf = fs.readFileSync(p);
      if (seed.get(p) === sha(buf)) continue;
      const inCwd = inside(cwd, p);
      const w = { path: (inCwd ? 'cwd/' : 'home/') + path.relative(inCwd ? cwd : home, p).split(path.sep).join('/'), bytes: buf.length, sha256: sha(buf) };
      if (buf.length <= TEXT_FILE_CAP && isUtf8(buf)) w.text = buf.toString('utf8');
      written.push(w);
    }
    return { ...res, ...state, noResult: !fs.existsSync(resultFile), stdout: text('stdout'), stderr: text('stderr'), cut, written, mode };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--app');
  const dash = process.argv.indexOf('--');
  if (i < 0 || dash < 0) { console.error('usage: node run.mjs --app <run.json> -- \'<steps json>\''); process.exit(2); }
  const appFile = path.resolve(process.argv[i + 1]);
  const ctx = prepare(JSON.parse(fs.readFileSync(appFile, 'utf8')), appFile);
  console.log(JSON.stringify(await runSteps(ctx, JSON.parse(process.argv[dash + 1])), null, 2));
}

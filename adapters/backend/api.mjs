// Backend adapter: start the HTTP service named by run.json in isolation and call it.
// run.json: { platform: "backend", dir?, install?, build?, start, address, openapi?, readyPath?, env? }
// As a module: const ctx = prepare(run, runFile); await call(ctx, { method, path, ... }); await restart(ctx, { fresh: true }); await stop(ctx).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertLocalhost, scrub, sleep } from '../web/context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_ALLOW = ['PATH', 'LANG', 'SystemRoot'];
const DEAD_PROXY = '127.0.0.1:9';
export const BODY_CAP = 1024 * 1024;
const HEADER_ALLOW = ['content-type', 'content-length', 'allow', 'link', 'location', 'cache-control', 'www-authenticate', 'retry-after',
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers'];
// Stores that live outside this machine: a stand-in value in run.env must point at this machine.
const STORE_SCHEME = /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|amqps?|memcached|cockroachdb|sqlserver|mssql|clickhouse|kafka|nats):\/\//i;
const STORE_HOST_KEY = /^(DB|DATABASE|PG|POSTGRES|MYSQL|REDIS|MONGO|MONGODB|AMQP|RABBITMQ|MEMCACHED)_?HOST$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '']);

function assertPosix() {
  if (process.platform === 'win32') throw new Error('backend adapter: process-group kill is not supported on Windows');
}
const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Refuses a stand-in that points at a store outside this machine.
export function checkEnv(env = {}) {
  for (const [k, v] of Object.entries(env)) {
    const s = String(v);
    if (STORE_SCHEME.test(s)) {
      let host = '';
      try { host = new URL(s).hostname; } catch { host = (/^[a-z+]+:\/\/(?:[^@/]*@)?([^:/?#]*)/i.exec(s) || [])[1] || 'unknown'; }
      if (!LOCAL_HOSTS.has(host.toLowerCase())) throw new Error(`run.json env ${k} points at a store outside this machine (${host}); a run never reviews against a shared or real store. Use a stand-in on this machine.`);
    } else if (STORE_HOST_KEY.test(k) && !LOCAL_HOSTS.has(s.toLowerCase())) {
      throw new Error(`run.json env ${k} points at a store outside this machine (${s}); a run never reviews against a shared or real store. Use a stand-in on this machine.`);
    }
  }
}

const prepared = new Map();
// Install and build once (RR_PREPARED=1 skips them). Returns the context every other function takes.
export function prepare(run, runFile) {
  assertPosix();
  const key = path.resolve(runFile);
  if (prepared.has(key)) return prepared.get(key);
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  if (typeof run.start !== 'string' || !run.start) throw new Error('run.json "start" must be the command that starts the service');
  const origin = assertLocalhost(run.address).origin;
  const base = path.basename(key) === 'rebuild-run.json' ? path.dirname(key) : path.join(path.dirname(key), 'work');
  const workDir = path.resolve(base, run.dir || '.');
  if (!inside(base, workDir)) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  checkEnv(run.env);
  let buildMs = null;
  if (process.env.RR_PREPARED !== '1') {
    if (run.install) execSync(run.install, { cwd: workDir, stdio: 'inherit' });
    if (run.build) { const t = Date.now(); execSync(run.build, { cwd: workDir, stdio: 'inherit' }); buildMs = Date.now() - t; }
  }
  const baseline = untracked(workDir);
  const ctx = { run, runFile: key, workDir, baseline: baseline && new Set(baseline), origin, port: new URL(origin).port, buildMs, proc: null, worker: null, root: null, log: '', startupMs: null, readyMs: Number(process.env.RR_READY_MS) || 30000 };
  prepared.set(key, ctx);
  return ctx;
}

let nsOk;
// 'namespace': the service runs in a new user and network namespace with only loopback (Linux, when unshare and ip are allowed). 'proxy': the proxy variables point at a dead address.
export function networkMode() {
  if (nsOk === undefined) nsOk = process.platform === 'linux' && spawnSync('unshare', ['--user', '--net', '--map-root-user', 'sh', '-c', LO_UP], { stdio: 'ignore' }).status === 0;
  return nsOk ? 'namespace' : 'proxy';
}
const LO_UP = 'ip link set lo up 2>/dev/null || /usr/sbin/ip link set lo up 2>/dev/null || /sbin/ip link set lo up';

// Children that have not emitted 'exit'. A group is signalled only through one of these, never by a pid kept after its child ended (the number may belong to something else by then).
const groups = new Set();
const isLive = (c) => c.exitCode === null && c.signalCode === null && !c.rrExited;
function track(child, onGone) {
  groups.add(child);
  child.on('exit', () => { child.rrExited = true; groups.delete(child); if (onGone) onGone(); });
}
export function killGroup(child) { if (child && child.pid && isLive(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
function killAll() { for (const c of [...groups]) killGroup(c); }
function forgetPid(file, pid) {
  try { fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && Number(l) !== pid).join('\n') + '\n'); } catch {}
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(1); });

function serviceEnv(ctx) {
  const e = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) e[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^LC_/.test(k)) e[k] = process.env[k];
  Object.assign(e, ctx.run.env || {});
  const home = path.join(ctx.root, 'home'), tmp = path.join(ctx.root, 'tmp');
  const proxy = `http://${DEAD_PROXY}`;
  Object.assign(e, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    TMPDIR: tmp, TEMP: tmp,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NODE_USE_ENV_PROXY: '1', CI: '1', PORT: ctx.port,
  });
  delete e.NO_PROXY; delete e.no_proxy;
  return e;
}

// One line in, one line out: runs doFetch inside the service's network namespace.
function startWorker(ctx) {
  const child = spawn(process.env.RR_NSENTER || 'nsenter', ['--target', String(ctx.proc.pid), '--user', '--net', '--preserve-credentials', '--', process.execPath, path.join(HERE, 'worker.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const w = { child, pending: new Map(), n: 0, buf: '', err: '', gone: null };
  child.stderr.on('data', (d) => { w.err = (w.err + d).slice(-4096); });
  child.on('exit', (c, sig) => { w.gone = `exit ${c ?? sig}`; });
  track(child);
  child.stdout.on('data', (d) => {
    w.buf += d;
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      try { const m = JSON.parse(line); const p = w.pending.get(m.id); if (p) { w.pending.delete(m.id); p(m.res); } } catch {}
    }
  });
  child.stdin.on('error', () => {});
  const dead = () => { for (const p of w.pending.values()) p({ status: 0, headers: {}, body: '', bytes: 0, ms: 0, error: 'the call helper in the service namespace ended' }); w.pending.clear(); };
  child.on('exit', dead);
  w.send = (origin, req) => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode !== null) return resolve({ status: 0, headers: {}, body: '', bytes: 0, ms: 0, error: 'the call helper in the service namespace ended' }); const id = ++w.n; w.pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, origin, req }) + '\n'); });
  return w;
}

// Starts the service. Reuses the temp root unless it was removed (stop with fresh). Returns when any HTTP answer comes from readyPath; startupMs is the time to it.
export async function start(ctx) {
  assertPosix();
  if (ctx.proc) return ctx;
  if (networkMode() === 'proxy' && await fetch(ctx.origin).then(() => true, () => false)) throw new Error(`refusing to start: something already answers on ${ctx.origin}`);
  if (!ctx.root) {
    ctx.root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RR_TMP_PARENT || os.tmpdir(), 'rr-backend-')));
    fs.mkdirSync(path.join(ctx.root, 'home')); fs.mkdirSync(path.join(ctx.root, 'tmp'));
  }
  const env = serviceEnv(ctx);
  let file = 'sh', argv = ['-c', ctx.run.start];
  if (networkMode() === 'namespace') { file = 'unshare'; argv = ['--user', '--net', '--map-root-user', '--', 'sh', '-c', `${LO_UP}; exec sh -c "$1"`, 'sh', ctx.run.start]; }
  ctx.log = '';
  const t0 = Date.now();
  const child = spawn(file, argv, { cwd: ctx.workDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const groupsFile = process.env.RR_TMP_PARENT ? path.join(process.env.RR_TMP_PARENT, 'groups') : null;
  track(child, groupsFile ? () => forgetPid(groupsFile, child.pid) : null);
  if (groupsFile) fs.appendFileSync(groupsFile, child.pid + '\n');
  const take = (d) => { ctx.log = (ctx.log + d).slice(-65536); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  let exited = null;
  child.on('exit', (c, s) => { exited = `exit ${c ?? s}`; });
  child.on('error', (e) => { exited = e.message; });
  ctx.proc = child;
  if (networkMode() === 'namespace') {
    // The helper may enter the namespace only after unshare has made it and mapped the user.
    const mine = fs.readlinkSync('/proc/self/ns/net');
    for (let i = 0; i < 100 && !exited; i++) {
      try { if (fs.readlinkSync(`/proc/${child.pid}/ns/net`) !== mine && fs.readFileSync(`/proc/${child.pid}/uid_map`, 'utf8').trim()) break; } catch {}
      await sleep(20);
    }
    if (!exited) ctx.worker = startWorker(ctx);
  }
  const ready = new URL(ctx.run.readyPath || '/', ctx.origin).pathname;
  for (;;) {
    if (ctx.worker && ctx.worker.gone) { const w = ctx.worker, lastErr = scrub(w.err.trim().split('\n').pop() || 'no output'); await stop(ctx); throw new Error(`the call helper in the service namespace ended before the service answered (${w.gone}): ${lastErr}`); }
    if (exited) { const log = ctx.log; await stop(ctx); throw new Error(`the service ended before it answered (${exited}): ${scrub(log.trim().split('\n').slice(-5).join(' | '))}`); }
    const r = await doFetchVia(ctx, { path: ready, timeoutMs: 2000 });
    if (r.status > 0) break;
    if (Date.now() - t0 > ctx.readyMs) { const log = ctx.log; await stop(ctx); throw new Error(`the service did not answer on ${ctx.origin} within ${Math.round(ctx.readyMs / 1000)} s: ${scrub(log.trim().split('\n').slice(-5).join(' | '))}`); }
    await sleep(100);
  }
  ctx.startupMs = Date.now() - t0;
  return ctx;
}

// Kills the service and everything it started (its whole process group).
export async function stop(ctx, { removeRoot = false } = {}) {
  for (const p of [ctx.proc, ctx.worker && ctx.worker.child]) killGroup(p);
  const procs = [ctx.proc, ctx.worker && ctx.worker.child].filter(Boolean);
  ctx.proc = null; ctx.worker = null;
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) await new Promise((r) => { p.once('exit', r); setTimeout(r, 1000); });
  if (removeRoot && ctx.root) { fs.rmSync(ctx.root, { recursive: true, force: true }); ctx.root = null; }
}

// Untracked files (ignored ones too) in the work copy, relative to it, without node_modules. null when it is not a git work copy.
function untracked(workDir) {
  const r = spawnSync('git', ['-C', workDir, 'ls-files', '-o', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter((f) => f && !f.split('/').includes('node_modules'));
}
// A fresh start also empties file stores in the work copy: untracked files that were not there after the build go, and tracked files return to their committed state. The target is never touched (this runs in the run's work copy only).
function resetWork(ctx) {
  if (!ctx.baseline) return;
  const now = untracked(ctx.workDir) || [];
  for (const f of now) {
    if (ctx.baseline.has(f)) continue;
    const p = path.resolve(ctx.workDir, f);
    if (inside(ctx.workDir, p)) fs.rmSync(p, { force: true });
  }
  spawnSync('git', ['-C', ctx.workDir, 'checkout', '--', '.'], { stdio: 'ignore' });
}

// fresh: true (default) starts again with an empty temp home and temp folder, so embedded stores start empty.
export async function restart(ctx, { fresh = true } = {}) {
  await stop(ctx, { removeRoot: fresh });
  if (fresh) resetWork(ctx);
  return start(ctx);
}

// ---- calling ----
// Returns { status, headers (allowlist), body (JSON parsed when the content-type says JSON, else text), bytes, ms, cut?, binary?, error? }. status 0 means no answer.
export async function doFetch(origin, { method = 'GET', path: p = '/', headers = {}, query, body, timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  let url;
  try {
    url = new URL(p, origin);
    if (url.origin !== origin) return { status: 0, headers: {}, body: '', bytes: 0, ms: 0, error: `refused: ${scrub(p)} is not on ${origin}` };
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  } catch (e) { return { status: 0, headers: {}, body: '', bytes: 0, ms: 0, error: scrub(e.message) }; }
  const h = { ...headers };
  let payload;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
    else { payload = JSON.stringify(body); if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'; }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status = 0, outHeaders = {}, error;
  const chunks = [];
  let size = 0, cut = false;
  try {
    const res = await fetch(url, { method, headers: h, body: payload, signal: ac.signal, redirect: 'manual' });
    status = res.status;
    for (const n of HEADER_ALLOW) { const v = res.headers.get(n); if (v !== null) outHeaders[n] = v; }
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size >= BODY_CAP) { cut = true; break; }
        const room = BODY_CAP - size;
        const part = value.length > room ? value.subarray(0, room) : value;
        if (value.length > room) cut = true;
        size += part.length; chunks.push(Buffer.from(part));
        if (cut) break;
      }
      if (cut) reader.cancel().catch(() => {});
    }
  } catch (e) {
    error = ac.signal.aborted ? 'timeout' : scrub(e.cause && e.cause.code ? `${e.message}: ${e.cause.code}` : e.message);
  } finally { clearTimeout(timer); }
  const buf = Buffer.concat(chunks);
  const r = { status, headers: outHeaders, bytes: size, ms: Date.now() - t0 };
  if (isUtf8(cut ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf)) {
    const text = buf.toString('utf8');
    let parsed = text;
    if (/json/i.test(outHeaders['content-type'] || '') && !cut) { try { parsed = JSON.parse(text); } catch {} }
    r.body = parsed;
  } else { r.body = ''; r.binary = true; }
  if (cut) r.cut = true;
  if (error) r.error = error;
  return r;
}

async function doFetchVia(ctx, req) {
  return ctx.worker ? ctx.worker.send(ctx.origin, req) : doFetch(ctx.origin, req);
}

// Starts the service first when it is not running.
export async function call(ctx, req) {
  if (!ctx.proc || ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) { if (ctx.proc) await stop(ctx); await start(ctx); }
  return doFetchVia(ctx, req);
}

// scrub on every string inside a parsed value (keys stay), so a pattern can never break the JSON.
export function scrubDeep(v) {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}

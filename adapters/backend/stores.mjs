// Stores for the backend adapter: databases and caches the service needs, run as throwaway containers on a private network.
// run.json "stores": [{ name, image (by digest), port, env?, ready?, memory? }]. The service reaches a store on 127.0.0.1:<port>; a relay carries the connection to the container.
// A container name, network name and label say who owns them, so a later run can remove what a killed run left. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scrub, sleep } from '../web/context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAX_STORES = 5;
export const SOCKET_PATH_MAX = 100;
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const DIGEST_RE = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MEMORY_RE = /^[1-9]\d*[bkmg]?$/i;
const KEYS = new Set(['name', 'image', 'port', 'env', 'ready', 'memory']);
const DEFAULT_MEMORY = '1g';
const PIDS_LIMIT = '512';
const SWEEP_MIN_AGE_MS = 60000;
const CALL_MS = 30000;

// Refuses a bad stores list, naming the problem. servicePort is the port of run.address.
export function validateStores(stores, servicePort) {
  if (!Array.isArray(stores)) throw new Error('run.json "stores" must be a list');
  if (stores.length > MAX_STORES) throw new Error(`run.json "stores" holds ${stores.length} stores; at most ${MAX_STORES} are allowed`);
  const names = new Set(), ports = new Map();
  stores.forEach((s, i) => {
    const at = `run.json stores[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at} must be an object`);
    for (const k of Object.keys(s)) if (!KEYS.has(k)) throw new Error(`${at} has an unknown key "${k}"; allowed: ${[...KEYS].join(', ')}`);
    if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) throw new Error(`${at} name must match ${NAME_RE}`);
    const who = `store "${s.name}"`;
    if (names.has(s.name)) throw new Error(`${who}: the name is used twice`);
    names.add(s.name);
    if (typeof s.image !== 'string' || !DIGEST_RE.test(s.image)) throw new Error(`${who}: image must be given by digest (name@sha256:<64 hex>), not by tag`);
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error(`${who}: port must be a whole number from 1 to 65535`);
    if (ports.has(s.port)) throw new Error(`${who}: port ${s.port} is already used by store "${ports.get(s.port)}"`);
    ports.set(s.port, s.name);
    if (Number(servicePort) === s.port) throw new Error(`${who}: port ${s.port} is the port of the service itself`);
    if (s.env !== undefined) {
      if (!s.env || typeof s.env !== 'object' || Array.isArray(s.env)) throw new Error(`${who}: env must be an object of strings`);
      for (const [k, v] of Object.entries(s.env)) if (!ENV_KEY_RE.test(k)) throw new Error(`${who}: env name "${k}" must match ${ENV_KEY_RE}`); else if (typeof v !== 'string') throw new Error(`${who}: env ${k} must be a string`);
    }
    if (s.ready !== undefined && (!Array.isArray(s.ready) || !s.ready.length || s.ready.some((x) => typeof x !== 'string'))) throw new Error(`${who}: ready must be a command as a list of strings`);
    if (s.memory !== undefined && (typeof s.memory !== 'string' || !MEMORY_RE.test(s.memory))) throw new Error(`${who}: memory must look like 512m or 2g`);
  });
  return stores;
}

const rtRun = (rt, args, timeout = CALL_MS) => spawnSync(rt, args, { encoding: 'utf8', timeout, env: process.env });
const lastLine = (r) => scrub(String((r.stderr || '').trim() || (r.stdout || '').trim() || (r.error && r.error.message) || 'no output').split('\n').pop());

// The container command: RR_CONTAINER, else docker, else podman. A rootless runtime is refused: its container addresses cannot be reached from this machine.
export function runtime() {
  const forced = process.env.RR_CONTAINER;
  const candidates = forced ? [forced] : ['docker', 'podman'];
  for (const c of candidates) {
    if (rtRun(c, ['version'], 15000).status !== 0) continue;
    const info = rtRun(c, ['info'], 30000);
    if (info.status !== 0) throw new Error(`run.json stores needs a container runtime that answers "${path.basename(c)} info"; it failed: ${lastLine(info)}`);
    if (/^\s*rootless:\s*true\s*$/mi.test(info.stdout) || /^\s*rootless\s*$/mi.test(info.stdout)) throw new Error(`the container runtime ${path.basename(c)} is rootless; its container addresses cannot be reached from this machine. Use a rootful runtime for run.json stores.`);
    return c;
  }
  throw new Error(`run.json stores needs a container runtime, and ${forced ? `RR_CONTAINER (${forced}) does not work` : 'neither docker nor podman works'} on this machine. Install docker or podman, or remove stores from run.json.`);
}

// Pulls every image (the only step that uses the network). Containers are later run with --pull=never.
export function pullAll(rt, stores) {
  for (const s of stores) {
    const r = rtRun(rt, ['pull', s.image], 600000);
    if (r.status !== 0) throw new Error(`store "${s.name}": pulling ${s.image} failed: ${lastLine(r)}`);
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Removes containers and networks labelled by this adapter whose owner process (same host) is gone and that are older than a minute. Returns the names removed.
export function sweep(rt) {
  const removed = [];
  const stale = (text) => {
    const [owner, host, created] = String(text).trim().split(' ');
    const when = Date.parse(String(created).replace(/"/g, ''));
    return host === os.hostname() && Number.isInteger(Number(owner)) && Number(owner) > 0 && Date.now() - when > SWEEP_MIN_AGE_MS && !pidAlive(Number(owner));
  };
  const list = (args) => { const r = rtRun(rt, args); return r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : []; };
  for (const id of list(['ps', '-a', '-q', '--filter', 'label=rr-backend=1'])) {
    const r = rtRun(rt, ['inspect', '--format', '{{index .Config.Labels "rr-owner"}} {{index .Config.Labels "rr-host"}} {{json .Created}}', id]);
    if (r.status === 0 && stale(r.stdout) && rtRun(rt, ['rm', '-f', id]).status === 0) removed.push(id);
  }
  for (const id of list(['network', 'ls', '-q', '--filter', 'label=rr-backend=1'])) {
    const r = rtRun(rt, ['network', 'inspect', '--format', '{{index .Labels "rr-owner"}} {{index .Labels "rr-host"}} {{json .Created}}', id]);
    if (r.status === 0 && stale(r.stdout) && rtRun(rt, ['network', 'rm', id]).status === 0) removed.push(id);
  }
  return removed;
}

export const socketPath = (root, name) => path.join(root, `${name}.sock`);
// Refuses (before anything starts) a socket path the system cannot bind.
export function checkSocketPaths(root, stores) {
  for (const s of stores) {
    const p = socketPath(root, s.name);
    if (Buffer.byteLength(p) > SOCKET_PATH_MAX) throw new Error(`the socket path for store "${s.name}" is ${Buffer.byteLength(p)} bytes (${p}); the limit is ${SOCKET_PATH_MAX}. Use a shorter RR_TMP_PARENT or temp folder.`);
  }
}
// Proxy mode: the host relay listens on 127.0.0.1:<port>, so a port that is taken is refused and nothing is killed.
export async function checkPortsFree(stores) {
  for (const s of stores) {
    const err = await new Promise((resolve) => { const srv = net.createServer(); srv.once('error', (e) => resolve(e)); srv.listen(s.port, '127.0.0.1', () => srv.close(() => resolve(null))); });
    if (err) throw new Error(`store "${s.name}": port ${s.port} on 127.0.0.1 is already in use on this machine (${err.code || err.message}); in proxy mode the service reaches its store there. Free the port or change it in run.json.`);
  }
}

function record(kind, name) {
  if (process.env.RR_TMP_PARENT) { try { fs.appendFileSync(path.join(process.env.RR_TMP_PARENT, 'stores'), `${kind} ${name}\n`); } catch {} }
}

// Teardown, safe to call twice: relays, then containers (a missing one is fine), then the network. All of it is synchronous;
// the returned promise settles when the killed relays have emitted exit, or after EXIT_WAIT_MS for one that never does.
export const EXIT_WAIT_MS = 5000;
function removeAll(s) {
  const exits = [];
  for (const r of s.relays) {
    if (r.child.exitCode === null && r.child.signalCode === null) {
      r.stopping = true;
      exits.push(new Promise((resolve) => { const t = setTimeout(resolve, EXIT_WAIT_MS); r.child.once('exit', () => { clearTimeout(t); resolve(); }); }));
      try { r.child.kill('SIGKILL'); } catch {}
    }
  }
  for (const c of s.cnames) rtRun(s.rt, ['rm', '-f', c], 20000);
  if (s.net) rtRun(s.rt, ['network', 'rm', s.net], 20000);
  s.relays = []; s.cnames = []; s.net = null; s.addrs = []; s.up = false;
  return Promise.all(exits);
}
export async function stopStores(ctx) { if (ctx && ctx.stores) await removeAll(ctx.stores); }
export function cleanupSync(ctx) { if (ctx && ctx.stores) removeAll(ctx.stores); }

// Removes what the lines of <tmpParent>/stores name (parity: a test killed hard left them).
export function removeListed(tmpParent) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(tmpParent, 'stores'), 'utf8').split('\n').filter(Boolean); } catch { return; }
  if (!lines.length) return;
  const rt = runtime();
  for (const l of lines) if (l.startsWith('container ')) rtRun(rt, ['rm', '-f', l.slice(10)], 20000);
  for (const l of lines) if (l.startsWith('network ')) rtRun(rt, ['network', 'rm', l.slice(8)], 20000);
}

function tcpOpen(host, port, ms) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port });
    const done = (v) => { c.destroy(); resolve(v); };
    c.setTimeout(ms, () => done(false)); c.on('connect', () => done(true)); c.on('error', () => done(false));
  });
}
const logTail = (s, cname) => { const r = rtRun(s.rt, ['logs', '--tail', '5', cname], 15000); return scrub(((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-5).join(' | ') || 'no log output'); };

async function waitStoreReady(s, store, cname, addr) {
  const limit = Number(process.env.RR_STORE_READY_MS) || 120000;
  const t0 = Date.now();
  for (;;) {
    const st = rtRun(s.rt, ['inspect', '--format', '{{.State.Running}}', cname], 15000);
    if (st.status === 0 && st.stdout.trim() === 'false') throw new Error(`store "${store.name}" exited before it was ready: ${logTail(s, cname)}`);
    const left = limit - (Date.now() - t0);
    if (store.ready) { if (rtRun(s.rt, ['exec', cname, ...store.ready], Math.max(500, Math.min(10000, left))).status === 0) return; }
    else if (await tcpOpen(addr, store.port, 1000)) return;
    if (Date.now() - t0 >= limit) throw new Error(`store "${store.name}" did not become ready within ${Math.round(limit / 1000)} s: ${logTail(s, cname)}`);
    await sleep(200);
  }
}

// Starts one relay and waits for its ready file; a relay that ends or stays silent is an error with its own message.
async function startRelay(ctx, s, name, from, to, tag) {
  const root = ctx.root;
  const ready = path.join(root, `${name}.${tag}.ready`), logFile = path.join(root, `${name}.${tag}.log`);
  fs.rmSync(ready, { force: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'relay.mjs'), from, to], { detached: true, stdio: ['ignore', 'ignore', fd], env: { PATH: process.env.PATH || '', RELAY_READY: ready } });
  fs.closeSync(fd);
  const r = { child, name, stopping: false };
  s.relays.push(r);
  if (s.track) s.track(child);
  child.on('exit', (c, sig) => { if (!r.stopping) s.relayGone = `the relay for store "${name}" ended (${c ?? sig})`; });
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(ready)) return;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(50);
  }
  throw new Error(`the relay for store "${name}" did not start: ${scrub(fs.readFileSync(logFile, 'utf8').trim().split('\n').pop() || 'no output')}`);
}

// Brings the stores up: network, containers, wait until ready, relays. Any failure takes everything down again before it is rethrown.
// ctx.stores: { list, rt, mode (set by the caller), up, net, cnames, addrs, relays }. Names are recorded before anything is created.
export async function startStores(ctx) {
  const s = ctx.stores;
  if (!s || s.up) return;
  s.relayGone = null;
  s.net = `rr-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  s.cnames = s.list.map((x) => `${s.net}-${x.name}`);
  record('network', s.net);
  for (const c of s.cnames) record('container', c);
  const owner = Number(process.env.RR_STORE_OWNER) || process.pid;
  const labels = ['--label', 'rr-backend=1', '--label', `rr-owner=${owner}`, '--label', `rr-host=${os.hostname()}`];
  try {
    const nr = rtRun(s.rt, ['network', 'create', '--internal', ...labels, s.net]);
    if (nr.status !== 0) throw new Error(`could not create the private network for the stores: ${lastLine(nr)}`);
    for (let i = 0; i < s.list.length; i++) {
      const st = s.list[i], cname = s.cnames[i];
      const envArgs = Object.entries(st.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const rr = rtRun(s.rt, ['run', '-d', '--name', cname, '--network', s.net, '--pull=never', '--memory', st.memory || DEFAULT_MEMORY, '--pids-limit', PIDS_LIMIT, ...labels, '--label', `rr-port=${st.port}`, ...envArgs, st.image]);
      if (rr.status !== 0) throw new Error(`store "${st.name}": could not start its container: ${lastLine(rr)}`);
      const ins = rtRun(s.rt, ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', cname]);
      const addr = ins.status === 0 ? ins.stdout.trim() : '';
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) throw new Error(`store "${st.name}": no address for its container${ins.status === 0 ? '' : ': ' + lastLine(ins)}`);
      s.addrs[i] = addr;
      await waitStoreReady(s, st, cname, addr);
    }
    // The host side listens before the service starts. In namespace mode the service's own relays (started by the wrapper) connect to these sockets, one connection at a time, so the order is safe.
    for (let i = 0; i < s.list.length; i++) {
      const st = s.list[i];
      if (s.mode === 'namespace') await startRelay(ctx, s, st.name, `unix:${socketPath(ctx.root, st.name)}`, `${s.addrs[i]}:${st.port}`, 'host');
      else await startRelay(ctx, s, st.name, `127.0.0.1:${st.port}`, `${s.addrs[i]}:${st.port}`, 'host');
    }
    s.up = true;
  } catch (e) {
    await removeAll(s);
    throw e;
  }
}

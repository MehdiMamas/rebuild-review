// CLI adapter: run the command-line tool named by run.json, one isolated invocation at a time.
// run.json: { platform: "cli", dir?, install?, build?, command: ["<exe>", "<fixed args>"...], env? }
// As a module: const ctx = prepare(run, runFile); const r = await runCli(ctx, { args, stdin, env, files, timeoutMs }).
// As a command: node run.mjs --app run.json -- <args>   (prints the result as JSON)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENV_ALLOW = ['PATH', 'LANG', 'TMPDIR', 'TEMP', 'SystemRoot'];
const DEAD_PROXY = '127.0.0.1:9';
export const OUTPUT_CAP = 1024 * 1024;
export const TEXT_FILE_CAP = 256 * 1024;

function assertPosix() {
  if (process.platform === 'win32') throw new Error('CLI adapter: process-group kill is not supported on Windows');
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Returns { base, workDir, command }. dir and command[0] stay inside the folder holding the work copy.
export function locate(run, runFile) {
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  const base = path.basename(runFile) === 'rebuild-run.json' ? path.dirname(runFile) : path.join(path.dirname(runFile), 'work');
  const workDir = path.resolve(base, run.dir || '.');
  if (!inside(base, workDir)) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  if (!Array.isArray(run.command) || !run.command.length || run.command.some((c) => typeof c !== 'string')) throw new Error('run.json "command" must be a list of strings: the executable and its fixed arguments');
  const [exe, ...fixed] = run.command;
  let file = exe;
  if (path.isAbsolute(exe)) {
    if (!inside(base, exe)) throw new Error(`run.json "command[0]" must stay inside ${base}, got ${exe}`);
  } else if (exe.includes('/') || exe.startsWith('.')) {
    file = path.resolve(workDir, exe);
    if (!inside(base, file)) throw new Error(`run.json "command[0]" must stay inside ${base}, got ${exe}`);
  }
  // A fixed argument that looks like a path (has a slash, starts with a dot or has an extension) and names a file in the
  // work copy is given as that file's full path (the tool runs in a new folder); a bare word like a subcommand never is.
  const pathLike = (a) => a.includes('/') || a.startsWith('.') || path.extname(a) !== '';
  const args = fixed.map((a) => { const p = path.resolve(workDir, a); return !path.isAbsolute(a) && !a.startsWith('-') && pathLike(a) && inside(base, p) && isFile(p) ? p : a; });
  return { base, workDir, command: [file, ...args] };
}

const prepared = new Map();
// Install and build once (RR_PREPARED=1 skips them). Returns the context runCli takes.
export function prepare(run, runFile) {
  assertPosix();
  const key = path.resolve(runFile);
  if (prepared.has(key)) return prepared.get(key);
  const { workDir, command } = locate(run, key);
  let buildMs = null;
  if (process.env.RR_PREPARED !== '1') {
    if (run.install) execSync(run.install, { cwd: workDir, stdio: 'inherit' });
    if (run.build) { const t = Date.now(); execSync(run.build, { cwd: workDir, stdio: 'inherit' }); buildMs = Date.now() - t; }
  }
  const ctx = { run, runFile: key, workDir, command, buildMs };
  prepared.set(key, ctx);
  return ctx;
}

let nsOk;
// 'namespace': each run is inside a new user and network namespace (Linux, when unshare is allowed). 'proxy': the proxy variables point at a dead address.
export function networkMode() {
  if (nsOk === undefined) nsOk = process.platform === 'linux' && spawnSync('unshare', ['--user', '--net', '--map-root-user', 'true'], { stdio: 'ignore' }).status === 0;
  return nsOk ? 'namespace' : 'proxy';
}

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// stdin: a string written then closed (EOF); '' means closed at once. keepStdinOpen: a pipe that is never written to or closed.
// Returns { code, signal, stdout, stderr, stdoutB64?, stderrB64?, cut: {stdout, stderr}, ms, timedOut, error?, written: [{ path, bytes, sha256, text? }] }.
// written paths start with cwd/ or home/; text is the content of a UTF-8 file up to 256 KB.
export async function runCli(ctx, { args = [], stdin = '', keepStdinOpen = false, env = {}, files = {}, timeoutMs = 30000 } = {}) {
  assertPosix();
  const root = fs.mkdtempSync(path.join(process.env.RR_TMP_PARENT || os.tmpdir(), 'rr-cli-'));
  const cwd = path.join(root, 'cwd'), home = path.join(root, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.resolve(cwd, rel);
      if (!inside(cwd, p) || p === cwd) throw new Error(`file path must stay inside the working folder: ${rel}`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const seed = new Map(walk(cwd).map((p) => [p, sha(fs.readFileSync(p))]));
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
    const [exe, ...fixed] = ctx.command;
    let file = exe, argv = [...fixed, ...args];
    if (networkMode() === 'namespace') { file = 'unshare'; argv = ['--user', '--net', '--map-root-user', '--', exe, ...argv]; }

    const t0 = Date.now();
    const child = spawn(file, argv, { cwd, env: e, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = { stdout: [], stderr: [] }, size = { stdout: 0, stderr: 0 }, cut = { stdout: false, stderr: false };
    const take = (name) => (d) => {
      if (size[name] >= OUTPUT_CAP) { cut[name] = true; return; }
      const room = OUTPUT_CAP - size[name];
      if (d.length > room) { cut[name] = true; d = d.subarray(0, room); }
      size[name] += d.length; out[name].push(d);
    };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    child.stdin.on('error', () => {});
    if (!keepStdinOpen) child.stdin.end(stdin || undefined);
    else if (stdin) child.stdin.write(stdin);

    const state = await new Promise((resolve) => {
      let done = false, code = null, signal = null, timedOut = false, error, ms = 0, graceTimer;
      const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer); clearTimeout(graceTimer);
        killGroup(); // anything the tool left running in its group
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
        resolve({ code, signal, timedOut, error, ms });
      };
      child.on('error', (err) => { error = err.message; ms = Date.now() - t0; finish(); });
      child.on('exit', (c, s) => { code = c; signal = s; ms = Date.now() - t0; graceTimer = setTimeout(finish, 200); }); // a child holding the pipes open does not hold us
      child.on('close', finish);
    });

    const text = (name) => {
      const buf = Buffer.concat(out[name]);
      if (isUtf8(cut[name] ? buf.subarray(0, Math.max(0, buf.length - 3)) : buf)) return { s: buf.toString('utf8') };
      return { s: '', b64: buf.toString('base64') };
    };
    const so = text('stdout'), se = text('stderr');
    const written = [];
    for (const p of [...walk(cwd), ...walk(home)]) {
      const buf = fs.readFileSync(p);
      if (seed.get(p) === sha(buf)) continue;
      const rel = (inside(cwd, p) ? 'cwd/' : 'home/') + path.relative(inside(cwd, p) ? cwd : home, p).split(path.sep).join('/');
      const w = { path: rel, bytes: buf.length, sha256: sha(buf) };
      if (buf.length <= TEXT_FILE_CAP && isUtf8(buf)) w.text = buf.toString('utf8');
      written.push(w);
    }
    return { ...state, stdout: so.s, stderr: se.s, ...(so.b64 ? { stdoutB64: so.b64 } : {}), ...(se.b64 ? { stderrB64: se.b64 } : {}), cut, written };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--app');
  const dash = process.argv.indexOf('--');
  if (i < 0 || dash < 0) { console.error('usage: node run.mjs --app <run.json> -- <args>'); process.exit(2); }
  const appFile = path.resolve(process.argv[i + 1]);
  const ctx = prepare(JSON.parse(fs.readFileSync(appFile, 'utf8')), appFile);
  console.log(JSON.stringify(await runCli(ctx, { args: process.argv.slice(dash + 1) }), null, 2));
}

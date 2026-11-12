// Linux preflight for the sandbox: bwrap and socat must be there and work. Missing ones are fetched without root into a cache (like adapters/web/libs.mjs).
// Usage: node scripts/sandbox-deps.mjs   (exit 0, or the reason on stderr and exit 1)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLdd, dirSize, libDirs } from '../adapters/web/libs.mjs';

const CACHE_CAP = 50 * 1024 * 1024;
const TOOLS = { bwrap: 'bubblewrap', socat: 'socat' };
const PROBE = { bwrap: ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--unshare-all', 'true'], socat: ['-V'] };
// Shared library name (as ldd prints it) to its package. An unlisted one stops the run with its name.
const LIB_PACKAGES = { 'libcap.so.2': 'libcap2', 'libwrap.so.0': 'libwrap0', 'libssl.so.3': 'libssl3', 'libcrypto.so.3': 'libssl3', 'libreadline.so.8': 'libreadline8', 'libtinfo.so.6': 'libtinfo6' };
const INSTALL = 'sudo apt-get install bubblewrap socat';
const first = (r) => String((r && (r.stderr || (r.error && r.error.message) || r.stdout)) || 'unknown error').trim().split('\n')[0];

export const cacheDirFor = (env = process.env) => path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'rebuild-review', 'sandbox');

// Returns { bin, libs }: the cache bin folder and LD_LIBRARY_PATH value for the child, both '' when the cache holds nothing. Throws with the reason when the sandbox cannot start.
// deps: run(cmd, args, opts) spawnSync-like, platform, path (PATH value), for tests.
export function sandboxTools(cacheDir, deps = {}) {
  if ((deps.platform || process.platform) !== 'linux') return { bin: '', libs: '' };
  const run = deps.run || ((c, a, o) => spawnSync(c, a, { encoding: 'utf8', ...o }));
  const cacheBin = path.join(cacheDir, 'root', 'usr', 'bin');
  const locate = (name) => [...String(deps.path ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean), cacheBin].map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || null;
  const env = () => ({ ...process.env, LD_LIBRARY_PATH: [...libDirs(cacheDir), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') });
  const check = () => {
    const c = { missing: [], pkgs: new Set(), unmapped: [], fail: null };
    for (const tool of Object.keys(TOOLS)) {
      const p = locate(tool);
      if (!p) { c.missing.push(tool); continue; }
      const r = run(p, PROBE[tool], { env: env() });
      if (r.status === 0) continue;
      const libs = parseLdd(`${run('ldd', [p], { env: env() }).stdout || ''}`);
      if (!libs.length) { c.fail ||= { tool, line: first(r), cached: p.startsWith(cacheBin) }; continue; }
      for (const l of libs) { if (LIB_PACKAGES[l]) c.pkgs.add(LIB_PACKAGES[l]); else c.unmapped.push(l); }
    }
    return c;
  };
  const fetch = (c) => {
    const names = [...c.missing.map((t) => TOOLS[t]), ...c.pkgs];
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(cacheDir, 'tmp-'));
    const stop = (msg) => { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`${msg}. Install with: ${INSTALL}`); };
    for (const pkg of names) {
      let r = run('apt-get', ['download', pkg], { cwd: tmp });
      if (r.status !== 0 && !(r.error && r.error.code === 'ENOENT')) r = run('apt-get', ['download', `${pkg}t64`], { cwd: tmp });
      if (r.status === 0) continue;
      if (r.error && r.error.code === 'ENOENT') stop(`${c.missing.join(' and ')} not found and apt-get is not here`);
      if (/no installation candidate|no candidate|unable to locate/i.test(String(r.stderr))) stop(`apt-get download ${pkg} found no installation candidate: the package lists are empty, run sudo apt-get update`);
      stop(`apt-get download ${pkg} failed: ${first(r)}`);
    }
    for (const f of fs.readdirSync(tmp).filter((x) => x.endsWith('.deb'))) {
      const r = run('dpkg', ['-x', path.join(tmp, f), path.join(tmp, 'root')], {});
      if (r.status !== 0) stop(`dpkg -x ${f} failed: ${first(r)}`);
      fs.rmSync(path.join(tmp, f), { force: true });
    }
    if (dirSize(cacheDir) > CACHE_CAP) { fs.rmSync(cacheDir, { recursive: true, force: true }); throw new Error(`the sandbox tool cache would pass 50 MB. Install with: ${INSTALL}`); }
    // Unpacked apart and renamed, so a run that starts at the same time never sees a half-unpacked root.
    const root = path.join(cacheDir, 'root');
    try { if (fs.existsSync(root)) fs.cpSync(path.join(tmp, 'root'), root, { recursive: true }); else fs.renameSync(path.join(tmp, 'root'), root); }
    catch (e) { if (!fs.existsSync(path.join(root, 'usr', 'bin'))) throw e; }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  let fetched = false, removed = false;
  for (;;) {
    const c = check();
    if (c.unmapped.length) throw new Error(`a sandbox tool needs libraries this machine does not have and the check does not know their packages: ${c.unmapped.join(', ')}. Install them as system packages`);
    if (c.fail && !c.fail.cached) throw new Error(`${c.fail.tool} cannot start a sandbox here: ${c.fail.line}. User namespaces may be blocked; try: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`);
    if (c.fail && removed) throw new Error(`the cached ${c.fail.tool} cannot start a sandbox here: ${c.fail.line}. A copy outside /usr/bin cannot pass the AppArmor rule for unprivileged user namespaces; install the system package: ${INSTALL}`);
    if (!c.fail && !c.missing.length && !c.pkgs.size) break;
    if (!c.fail && fetched) throw new Error(`still missing after unpacking: ${[...c.missing, ...c.pkgs].join(', ')}. Install with: ${INSTALL}`);
    if (c.fail) { fs.rmSync(cacheDir, { recursive: true, force: true }); removed = true; continue; }
    fetch(c);
    fetched = true;
  }
  return fs.existsSync(cacheBin) ? { bin: cacheBin, libs: libDirs(cacheDir).join(':') } : { bin: '', libs: '' };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { sandboxTools(cacheDirFor(), { platform: process.env.RR_SANDBOX_PLATFORM }); }
  catch (e) { console.error(`sandbox: ${e.message}`); process.exit(1); }
}

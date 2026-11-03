// Linux preflight: shared libraries the Electron binary needs, fetched without root. No dependencies, so it is unit-tested alone.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LIB_CACHE_CAP = 300 * 1024 * 1024;
// Shared library name (as ldd prints it) to the Debian or Ubuntu package that holds it. Anything not listed stops the run with its name.
const LIB_PACKAGES = {
  'libnss3.so': 'libnss3', 'libnssutil3.so': 'libnss3', 'libsmime3.so': 'libnss3', 'libnspr4.so': 'libnspr4',
  'libasound.so.2': 'libasound2', 'libatk-1.0.so.0': 'libatk1.0-0', 'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0',
  'libatspi.so.0': 'libatspi2.0-0', 'libcups.so.2': 'libcups2', 'libdrm.so.2': 'libdrm2', 'libgbm.so.1': 'libgbm1',
  'libxkbcommon.so.0': 'libxkbcommon0', 'libXcomposite.so.1': 'libxcomposite1', 'libXdamage.so.1': 'libxdamage1',
  'libXfixes.so.3': 'libxfixes3', 'libXrandr.so.2': 'libxrandr2', 'libXtst.so.6': 'libxtst6', 'libXss.so.1': 'libxss1',
  'libpango-1.0.so.0': 'libpango-1.0-0', 'libcairo.so.2': 'libcairo2', 'libgtk-3.so.0': 'libgtk-3-0',
};
// Names of the libraries ldd reports as "not found".
export const parseLdd = (text) => [...new Set(String(text).split('\n').map((l) => /^\s*(\S+)\s+=>\s+not found/.exec(l)).filter(Boolean).map((m) => m[1]))];
// { packages, unmapped } for library names from parseLdd.
export function packagesFor(libs) {
  const packages = new Set(), unmapped = [];
  for (const l of libs) { const p = LIB_PACKAGES[l]; if (p) packages.add(p); else unmapped.push(l); }
  return { packages: [...packages], unmapped };
}
const libDirs = (cacheDir) => ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'usr/lib', 'lib'].map((d) => path.join(cacheDir, 'root', d)).filter((d) => fs.existsSync(d));
const dirSize = (d) => { let n = 0; for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return n; };
// Linux only, never with sudo: when ldd reports libraries missing for the Electron binary, downloads their packages with
// apt-get download, unpacks them with dpkg -x into cacheDir and returns a LD_LIBRARY_PATH value for them ('' when nothing is missing).
// Stops with the missing names and the first error line when apt-get or the network is not there, a library has no entry in the package map,
// or the cache would pass 300 MB. deps.run(cmd, args, opts) is spawnSync-like, for tests.
export function linuxLibs(executablePath, cacheDir, deps = {}) {
  if (process.platform !== 'linux' && !deps.run) return '';
  const run = deps.run || ((c, a, o) => spawnSync(c, a, { encoding: 'utf8', ...o }));
  const find = () => {
    const dirs = libDirs(cacheDir);
    const r = run('ldd', [executablePath], { env: { ...process.env, LD_LIBRARY_PATH: [...dirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
    return parseLdd(`${r.stdout || ''}`);
  };
  const missing = find();
  if (!missing.length) return libDirs(cacheDir).join(':');
  const { packages, unmapped } = packagesFor(missing);
  if (unmapped.length) throw new Error(`the Electron binary needs libraries this machine does not have and the adapter does not know their packages: ${unmapped.join(', ')}. Install them as system packages.`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const fail = (what, r) => new Error(`the Electron binary needs libraries this machine does not have (${missing.join(', ')}); ${what}: ${String((r && (r.stderr || (r.error && r.error.message))) || 'unknown error').trim().split('\n')[0]}`);
  for (const pkg of packages) {
    let r = run('apt-get', ['download', pkg], { cwd: cacheDir });
    if (r.status !== 0) r = run('apt-get', ['download', `${pkg}t64`], { cwd: cacheDir });
    if (r.status !== 0) throw fail(`apt-get download ${pkg} failed`, r);
  }
  for (const f of fs.readdirSync(cacheDir).filter((x) => x.endsWith('.deb'))) {
    const r = run('dpkg', ['-x', path.join(cacheDir, f), path.join(cacheDir, 'root')], {});
    if (r.status !== 0) throw fail(`dpkg -x ${f} failed`, r);
    fs.rmSync(path.join(cacheDir, f), { force: true });
  }
  if (dirSize(cacheDir) > LIB_CACHE_CAP) { fs.rmSync(cacheDir, { recursive: true, force: true }); throw fail('the library cache would pass 300 MB', null); }
  const still = find();
  if (still.length) throw new Error(`the Electron binary still lacks libraries after unpacking their packages: ${still.join(', ')}`);
  return libDirs(cacheDir).join(':');
}

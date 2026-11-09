// The app named by run.json: where it is, how it is built, what is in it. run.json:
// { platform: "ios", dir?, install?, build, app, bundleId, device?: { name, runtime? }, launch?: { args?, env? }, env? }
// `build` runs in work/<dir> with RUN_DIR set to the run folder (put derived data there: -derivedDataPath "$RUN_DIR/dd"); `app` is the
// built .app, relative to the run folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scrub } from '../web/context.mjs';

const inside = (base, p) => { const r = path.relative(base, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

export function locate(run, runFile) {
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  const rebuild = path.basename(runFile) === 'rebuild-run.json';
  const base = rebuild ? path.dirname(runFile) : path.join(path.dirname(runFile), 'work');
  const runDir = rebuild ? path.dirname(base) : path.dirname(runFile);
  const workDir = path.resolve(base, run.dir || '.');
  if (!inside(base, workDir)) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  if (typeof run.bundleId !== 'string' || !run.bundleId) throw new Error('run.json "bundleId" is required');
  if (typeof run.app !== 'string' || !run.app) throw new Error('run.json "app" is required: the built .app, relative to the run folder');
  if (path.isAbsolute(run.app)) throw new Error(`run.json "app" must be relative, got ${run.app}`);
  const appPath = path.resolve(runDir, run.app);
  if (!inside(runDir, appPath)) throw new Error(`run.json "app" must stay inside the run folder, got ${run.app}`);
  return { base, runDir, workDir, appPath };
}

const tail = (s, n) => String(s).split('\n').filter((l) => l.trim()).slice(-n).join('\n');
const prepared = new Map();
// Install and build once (RR_PREPARED=1 skips both). Returns { run, runFile, workDir, runDir, appPath, buildMs }.
export function prepare(run, runFile) {
  const key = path.resolve(runFile);
  if (prepared.has(key)) return prepared.get(key);
  const loc = locate(run, key);
  let buildMs = null;
  if (process.env.RR_PREPARED !== '1') {
    const env = { ...process.env, ...(run.env || {}), RUN_DIR: loc.runDir };
    if (run.install) { const r = spawnSync(run.install, { cwd: loc.workDir, shell: true, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`install failed (exit ${r.status}). Last lines of the log:\n${scrub(tail(`${r.stdout}\n${r.stderr}`, 20))}`); }
    if (!run.build) throw new Error('run.json "build" is required: the xcodebuild command for the simulator');
    const t = Date.now();
    const r = spawnSync(run.build, { cwd: loc.workDir, shell: true, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    buildMs = Date.now() - t;
    const log = `${r.stdout}\n${r.stderr}`;
    try { fs.writeFileSync(path.join(loc.runDir, 'ios-build.log'), log); } catch {}
    if (r.status !== 0) throw new Error(`The build failed (exit ${r.status}). Last lines of the build log:\n${scrub(tail(log, 20))}`);
  }
  if (!fs.existsSync(path.join(loc.appPath, 'Info.plist'))) throw new Error(`the built app was not found at ${run.app} (run.json "app")`);
  const id = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(loc.appPath, 'Info.plist')], { encoding: 'utf8' }).stdout.trim();
  if (id && id !== run.bundleId) throw new Error(`run.json "bundleId" is ${run.bundleId} but the built app is ${id}`);
  const ctx = { run, runFile: key, ...loc, buildMs };
  prepared.set(key, ctx);
  return ctx;
}

// Extensions and companions inside the app, which a simulator capture does not drive: ["ShareExt.appex", ...].
export function extensions(appPath) {
  const out = [];
  for (const [dir, ext] of [['PlugIns', '.appex'], ['Extensions', '.appex'], ['Watch', '.app']]) {
    try { for (const n of fs.readdirSync(path.join(appPath, dir))) if (n.endsWith(ext)) out.push(n); } catch {}
  }
  return out;
}
export const executableName = (appPath) => spawnSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(appPath, 'Info.plist')], { encoding: 'utf8' }).stdout.trim();
export const appBytes = (appPath) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) n += fs.statSync(p).size; } }; try { walk(appPath); } catch {} return n; };

// Addresses in the launch arguments and settings that name a server that is not this machine. The simulator shares the host network, so
// nothing blocks them; capture refuses them unless --allow-network is given.
export function nonLocalAddresses(run) {
  const own = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) own.add(i.address);
  const values = [...(run.launch?.args || []), ...Object.values(run.launch?.env || {}), ...Object.values(run.env || {})].map(String);
  const found = [];
  for (const v of values) {
    for (const m of v.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\/\s:?#]+|\[[^\]]+\])/gi)) {
      const host = m[1].replace(/^\[|\]$/g, '').toLowerCase();
      if (!own.has(host) && !found.includes(host)) found.push(host);
    }
  }
  return found;
}

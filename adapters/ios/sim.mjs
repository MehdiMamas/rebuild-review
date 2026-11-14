// Simulator control through simctl only. Headless: Simulator.app is never opened. Every device made here is named rr-<id>,
// is deleted when the process ends (also on SIGINT and SIGTERM), and nothing else on the machine is touched (never the `booted` alias).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { scrub } from '../web/context.mjs';

export const TEXT_FILE_CAP = 256 * 1024;

export function ensureMac() {
  if (process.platform !== 'darwin') throw new Error('iOS adapter needs macOS with Xcode: the iOS simulator runs only on a Mac');
  if (spawnSync('xcrun', ['--find', 'simctl'], { stdio: 'ignore' }).status !== 0) throw new Error('iOS adapter needs Xcode: xcrun cannot find simctl');
}

const simctl = (args, opts = {}) => spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const must = (r, what) => {
  if (r.status !== 0) throw new Error(`${what} failed: ${String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
  return String(r.stdout).trim();
};

// ---- runtimes ----
const versionParts = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
export const compareVersions = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

// runtimesJson: the output of `simctl list runtimes -j`. wanted: "iOS 18.3" or "18.3" (optional). sdk: the iOS SDK version Xcode builds with.
// Picks the wanted runtime, else the newest installed one. Throws with the exact runtime name when there is none.
export function pickRuntime(runtimesJson, { wanted, sdk } = {}) {
  const ios = (runtimesJson?.runtimes || []).filter((r) => r.isAvailable !== false && /SimRuntime\.iOS-/.test(r.identifier || ''));
  if (wanted) {
    const w = String(wanted).replace(/^iOS\s*/i, '').trim();
    const hit = ios.find((r) => r.version === w || r.name === wanted);
    if (!hit) throw new Error(`The iOS simulator runtime iOS ${w} is not installed. Install iOS ${w} (Xcode > Settings > Components) and run again.`);
    return { runtime: hit, sdk: sdk || null, olderThanSdk: !!sdk && compareVersions(hit.version, sdk) < 0 };
  }
  if (!ios.length) throw new Error(`No iOS simulator runtime is installed. Install the iOS ${sdk || ''} simulator runtime (Xcode > Settings > Components) and run again.`.replace('iOS  ', 'iOS '));
  const newest = [...ios].sort((a, b) => compareVersions(b.version, a.version))[0];
  return { runtime: newest, sdk: sdk || null, olderThanSdk: !!sdk && compareVersions(newest.version, sdk) < 0 };
}
export const listRuntimes = () => JSON.parse(must(simctl(['list', 'runtimes', '-j']), 'listing runtimes'));
export const sdkVersion = () => { const r = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
export const xcodeVersion = () => { const r = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim().split('\n').join(' ') : null; };

// ---- devices ----
const made = new Set();
const children = new Set();
export const track = (child) => { children.add(child); child.on('close', () => children.delete(child)); return child; };

export function cleanupSync() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch {} } }
  children.clear();
  for (const udid of [...made]) shutdownAndDeleteSync(udid);
}
let hooked = false;
function hook() {
  if (hooked) return; hooked = true;
  process.on('exit', cleanupSync);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { cleanupSync(); process.exit(code); });
}

export function deviceTypeId(name) {
  const j = JSON.parse(must(simctl(['list', 'devicetypes', '-j']), 'listing device types'));
  const hit = (j.devicetypes || []).find((d) => d.name === name);
  if (!hit) throw new Error(`device type "${name}" is not installed`);
  return hit.identifier;
}

// Returns { udid, name }. Throws when the device type does not exist or the runtime cannot host it.
export function createDevice({ typeName, runtime, tag }) {
  ensureMac(); hook();
  const name = `rr-${tag || crypto.randomBytes(3).toString('hex')}`;
  const udid = must(simctl(['create', name, deviceTypeId(typeName), runtime.identifier]), `creating the ${typeName} simulator`);
  made.add(udid);
  return { udid, name, typeName };
}
export function boot(udid) {
  must(simctl(['boot', udid]), 'booting the simulator');
  must(simctl(['bootstatus', udid, '-b'], { timeout: 300000 }), 'waiting for the simulator to finish booting');
}
export function shutdownAndDeleteSync(udid) {
  simctl(['shutdown', udid], { timeout: 60000 });
  simctl(['delete', udid], { timeout: 60000 });
  made.delete(udid);
}
export const shutdownAndDelete = async (udid) => shutdownAndDeleteSync(udid);
// Devices named rr-* that exist now (the end-of-run check).
export function leftoverDevices() {
  const j = JSON.parse(must(simctl(['list', 'devices', '-j']), 'listing devices'));
  return Object.values(j.devices || {}).flat().filter((d) => /^rr-/.test(d.name)).map((d) => `${d.name} ${d.udid}`);
}

export const install = (udid, appPath) => must(simctl(['install', udid, appPath]), 'installing the app');
// Launch fresh. env goes to the app with the SIMCTL_CHILD_ prefix. Returns { pid, ms }.
export function launch(udid, bundleId, { args = [], env = {} } = {}) {
  simctl(['terminate', udid, bundleId]);
  const e = { ...process.env };
  for (const [k, v] of Object.entries(env)) e[`SIMCTL_CHILD_${k}`] = String(v);
  const t = Date.now();
  const out = must(simctl(['launch', udid, bundleId, ...args.map(String)], { env: e }), 'launching the app');
  return { pid: Number(/:\s*(\d+)\s*$/.exec(out)?.[1]) || null, ms: Date.now() - t };
}
export const terminate = (udid, bundleId) => simctl(['terminate', udid, bundleId]);
// The app is running when launchd lists a pid for it.
export function isRunning(udid, bundleId) {
  const r = simctl(['spawn', udid, 'launchctl', 'list']);
  return String(r.stdout).split('\n').some((l) => l.includes(`UIKitApplication:${bundleId}`) && /^\d+\s/.test(l.trim()));
}
export const screenshot = (udid, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); must(simctl(['io', udid, 'screenshot', '--type=png', file]), 'taking a screenshot'); };
export const setAppearance = (udid, mode) => must(simctl(['ui', udid, 'appearance', mode]), 'setting the appearance');
export const setContentSize = (udid, size) => must(simctl(['ui', udid, 'content_size', size]), 'setting the text size');
export const overrideStatusBar = (udid) => simctl(['status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularBars', '4', '--wifiBars', '3']);

// Log lines of the app's subsystem, collected until stop(). Lines are scrubbed on read.
export function startLog(udid, subsystem) {
  const lines = [];
  const child = track(spawn('xcrun', ['simctl', 'spawn', udid, 'log', 'stream', '--predicate', `subsystem == "${subsystem}"`, '--level', 'debug', '--style', 'compact'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); for (const l of parts) if (l && !/^Filtering the log data|^Timestamp\s/.test(l)) lines.push(l); if (lines.length > 5000) lines.splice(0, lines.length - 5000); });
  return { lines: () => lines.map((l) => scrub(l)), stop: () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
}

// Crash reports the system wrote since `since` for an executable (read in place, not copied): "<exception type> in <file>".
export function crashReport(executable, since) {
  const dir = path.join(process.env.HOME || '', 'Library', 'Logs', 'DiagnosticReports');
  try {
    const files = fs.readdirSync(dir).filter((n) => n.startsWith(`${executable}-`) && /\.(ips|crash)$/.test(n)).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).filter((x) => x.t >= since).sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    const text = fs.readFileSync(path.join(dir, files[0].n), 'utf8');
    const type = /"type"\s*:\s*"([A-Z_]+)"/.exec(text)?.[1] || /Exception Type:\s*(\S+)/.exec(text)?.[1];
    return `crash report ${type || 'found'}`;
  } catch { return null; }
}

// Text files in the app's data container, up to 256 KB: [{ path, bytes, sha256, text? }]. Caches and system metadata are left out.
export function readContainer(udid, bundleId) {
  const r = simctl(['get_app_container', udid, bundleId, 'data']);
  if (r.status !== 0) return [];
  const root = r.stdout.trim();
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(root, p).split(path.sep).join('/');
      if (/^(Library\/(Caches|SplashBoard)|tmp|\.com\.apple)/.test(rel) || e.name.startsWith('.com.apple')) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        const w = { path: rel, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
        if (buf.length <= TEXT_FILE_CAP && isUtf8(buf)) w.text = scrub(buf.toString('utf8'));
        out.push(w);
      }
    }
  };
  try { walk(root); } catch {}
  return out;
}

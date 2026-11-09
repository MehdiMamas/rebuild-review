// Maestro on the simulator. Maestro runs the parity flows (`maestro test`). For capture it is started once with a trivial flow, which
// leaves its XCTest driver running on the simulator; that driver answers on a fixed local port (22087) with the full hierarchy, element types
// and exact frames (Maestro's own hierarchy output has no element type), and takes taps and text. One device at a time can use the port.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { track } from './sim.mjs';
import { flatten } from './screen.mjs';

export const DRIVER_PORT = 22087;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function maestroPath() {
  const home = os.homedir();
  for (const p of [process.env.RR_MAESTRO, path.join(home, '.maestro-rr/maestro/bin/maestro'), path.join(home, '.maestro/bin/maestro')]) if (p && fs.existsSync(p)) return p;
  const r = spawnSync('which', ['maestro'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error('Maestro is not installed (the iOS adapter drives the simulator with Maestro 2.x; it needs Java 17 or newer)');
}
export function maestroEnv() {
  const env = { ...process.env, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' };
  if (!env.JAVA_HOME) { const r = spawnSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' }); if (r.status === 0) env.JAVA_HOME = r.stdout.trim(); }
  return env;
}
export const maestroVersion = () => { try { const r = spawnSync(maestroPath(), ['--version'], { encoding: 'utf8', env: maestroEnv() }); return String(r.stdout).trim().split('\n').pop() || null; } catch { return null; } };

const portBusy = () => new Promise((resolve) => { const s = net.connect(DRIVER_PORT, '127.0.0.1'); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });

// Run a Maestro command in its own process group, killed whole on the time limit. Resolves { code, output, timedOut }.
export function maestro(args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = track(spawn(maestroPath(), args, { cwd, env: maestroEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    let output = '', timedOut = false, done = false;
    const take = (d) => { output = (output + d).slice(-20000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); kill(); resolve({ code, output: output.trim(), timedOut }); };
    child.on('error', (e) => { output += String(e.message); finish(1); });
    child.on('close', finish);
  });
}

// Start the driver on this device. `maestro test` stops its driver when it ends, so one flow is kept waiting for a label that never appears
// and is killed at stop(). Refuses when something already listens on the driver port (another device's driver).
export async function startDriver(udid, bundleId) {
  // The previous device's driver goes away with its simulator; give it a few seconds, then refuse.
  for (let i = 0; i < 10 && await portBusy(); i++) await sleep(500);
  if (await portBusy()) throw new Error(`port ${DRIVER_PORT} is already in use: another simulator's driver is running. Stop it and run again.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ios-flow-'));
  const flow = path.join(dir, 'keep.yaml');
  fs.writeFileSync(flow, `appId: ${bundleId}\n---\n- launchApp\n- extendedWaitUntil:\n    visible: "rr-driver-keepalive-never-shown"\n    timeout: 3600000\n`);
  const child = track(spawn(maestroPath(), ['--udid', udid, '--driver-host-port', String(DRIVER_PORT), 'test', flow], { env: maestroEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  let output = '', exited = false;
  const take = (d) => { output = (output + d).slice(-4000); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.on('close', () => { exited = true; });
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); };
  for (let i = 0; i < 360; i++) {
    if (await portBusy()) return { stop };
    if (exited) { stop(); throw new Error(`Maestro could not start its driver on the simulator: ${output.trim().split('\n').slice(-5).join(' ')}`); }
    await sleep(500);
  }
  stop();
  throw new Error('the Maestro driver did not come up on the simulator');
}

async function post(route, body, timeoutMs = 15000) {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}${route}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`driver ${route}: ${res.status} ${text.slice(0, 120)}`);
  return text ? JSON.parse(text) : {};
}
// The app's hierarchy now: { size, elements } (see screen.mjs flatten).
export async function hierarchy(bundleId) {
  return flatten(await post('/viewHierarchy', { appIds: [bundleId], excludeKeyboardElements: false }));
}
// Wait until the hierarchy has elements and stops changing between two reads.
export async function settled(bundleId, { tries = 20, gapMs = 300 } = {}) {
  let last = null, h;
  for (let i = 0; i < tries; i++) {
    try { h = await hierarchy(bundleId); } catch { h = { size: { width: 0, height: 0 }, elements: [] }; }
    const key = JSON.stringify(h.elements.map((e) => [e.type, e.label, e.frame]));
    if (h.elements.length && key === last) return h;
    last = key; await sleep(gapMs);
  }
  return h;
}
export const tap = (x, y) => post('/touch', { x, y, duration: 0.05 });
export const typeText = (bundleId, text) => post('/inputText', { text, appIds: [bundleId] });
export const center = (e) => ({ x: e.frame.x + e.frame.w / 2, y: e.frame.y + e.frame.h / 2 });
export { sleep };

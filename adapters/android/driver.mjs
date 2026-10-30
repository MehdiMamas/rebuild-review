// Android driver: plain adb and uiautomator, called from Node. Every adb call carries -s <serial>.
// Runs the states.json steps (open, click, type, press, wait, failRequest, slowRequest); #8 reuses it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { sleep } from '../web/context.mjs';

export const AVD = 'rebuild-review';
export const PORT = 5584; // fixed console port: serial emulator-5584. aces_van_demo and real devices are never touched.
export const SERIAL = `emulator-${PORT}`;
export const SIZES = { phone: { size: '1080x2400', density: 420 }, tablet: { size: '1600x2560', density: 320 } };

export function sdkRoot() {
  for (const d of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library/Android/sdk'), path.join(os.homedir(), 'Android/Sdk'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk')])
    if (d && fs.existsSync(path.join(d, 'platform-tools'))) return d;
  throw new Error('Android SDK not found: set ANDROID_HOME');
}
const sdkBin = (...p) => path.join(sdkRoot(), ...p);
const exe = (n) => (process.platform === 'win32' ? n + '.exe' : n);
const sh = (bin, args, opts = {}) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// Env for the app's install/build/start commands: the SDK, and a JDK 21 or 17 when one is installed (Gradle rejects the newest JDKs).
export function buildEnv() {
  const env = { ...process.env, ANDROID_HOME: sdkRoot(), ANDROID_SDK_ROOT: sdkRoot() };
  if (process.platform === 'darwin') for (const v of ['21', '17']) try { env.JAVA_HOME = sh('/usr/libexec/java_home', ['-v', v]).trim(); break; } catch {}
  return env;
}

export function adb(...args) { return sh(sdkBin('platform-tools', exe('adb')), ['-s', SERIAL, ...args]); }
export function adbBuf(...args) { return execFileSync(sdkBin('platform-tools', exe('adb')), ['-s', SERIAL, ...args], { maxBuffer: 256 << 20, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); }

export function ensureAvd() {
  const have = sh(sdkBin('emulator', exe('emulator')), ['-list-avds']).split('\n').map((s) => s.trim());
  if (have.includes(AVD)) return;
  const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const image = `system-images;android-35;google_apis;${abi}`;
  if (!fs.existsSync(sdkBin('system-images', 'android-35', 'google_apis', abi))) sh(sdkBin('cmdline-tools', 'latest', 'bin', exe('sdkmanager')), [image], { input: 'y\n', stdio: ['pipe', 'pipe', 'pipe'] }); // user scope, no sudo
  sh(sdkBin('cmdline-tools', 'latest', 'bin', exe('avdmanager')), ['create', 'avd', '-n', AVD, '-k', image, '-d', 'pixel_6'], { input: 'no\n', stdio: ['pipe', 'pipe', 'pipe'] });
}
export function deleteAvd() {
  try { sh(sdkBin('cmdline-tools', 'latest', 'bin', exe('avdmanager')), ['delete', 'avd', '-n', AVD]); } catch {}
}

// Starts the headless emulator with a clean disk and all traffic going through the proxy. Returns stop().
export async function startEmulator(proxyPort) {
  if (sh(sdkBin('platform-tools', exe('adb')), ['devices']).includes(SERIAL)) throw new Error(`refusing to start: something already runs as ${SERIAL}`);
  const proc = spawn(sdkBin('emulator', exe('emulator')), ['-avd', AVD, '-port', String(PORT), '-no-window', '-no-audio', '-no-boot-anim', '-wipe-data', '-no-snapshot-save', '-gpu', 'swiftshader_indirect', '-http-proxy', `http://127.0.0.1:${proxyPort}`], { stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const stop = async () => {
    if (exited) return;
    try { adb('emu', 'kill'); } catch {}
    for (let i = 0; i < 40 && !exited; i++) await sleep(500);
    if (!exited) proc.kill('SIGKILL');
  };
  const stopSync = () => { try { adb('emu', 'kill'); } catch {} try { proc.kill('SIGKILL'); } catch {} };
  process.on('exit', stopSync);
  try {
    for (let i = 0; ; i++) {
      if (exited) throw new Error('emulator exited during start');
      if (i > 90) throw new Error('emulator did not boot in 6 minutes');
      let b = ''; try { b = adb('shell', 'getprop', 'sys.boot_completed').trim(); } catch {}
      if (b === '1') break;
      await sleep(4000);
    }
    for (const s of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) adb('shell', 'settings', 'put', 'global', s, '0');
    adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '0');
    adb('shell', 'input', 'keyevent', '82');
    adb('logcat', '-G', '16M');
  } catch (e) { await stop(); throw e; }
  return stop;
}

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
export function parseDump(xml) {
  const nodes = [], stack = [];
  const re = /<node\s([^>]*?)(\/?)>|<\/node>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') { stack.pop(); continue; }
    const a = {};
    for (const x of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[x[1]] = unesc(x[2]);
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    nodes.push({ i: nodes.length, parent: stack.length ? stack[stack.length - 1] : -1, depth: stack.length, cls: a.class || '', pkg: a.package || '', text: a.text || '', desc: a['content-desc'] || '', id: a['resource-id'] || '',
      bounds: b ? b.slice(1).map(Number) : [0, 0, 0, 0], clickable: a.clickable === 'true', longClickable: a['long-clickable'] === 'true', scrollable: a.scrollable === 'true',
      enabled: a.enabled !== 'false', checkable: a.checkable === 'true', checked: a.checked === 'true', focusable: a.focusable === 'true' });
    if (!m[2]) stack.push(nodes.length - 1);
  }
  for (const n of nodes) n.label = n.desc || n.text;
  return nodes;
}
export const norm = (s) => s.replace(/\d+/g, '#');
export const center = (n) => [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];
export function labelBelow(nodes, i) {
  for (let j = i + 1; j < nodes.length && nodes[j].depth > nodes[i].depth; j++) if (nodes[j].label) return nodes[j].label;
  return '';
}

export class Device {
  constructor({ pkg, proxy }) { this.pkg = pkg; this.proxy = proxy; this.activity = null; this.launches = []; }
  setActivity() {
    const out = adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', this.pkg).trim().split('\n').pop().trim();
    if (!out.includes('/')) throw new Error(`no launchable activity for ${this.pkg}`);
    this.activity = out;
  }
  launch() {
    adb('shell', 'am', 'force-stop', this.pkg);
    const out = adb('shell', 'am', 'start', '-W', '-n', this.activity);
    const t = out.match(/TotalTime:\s*(\d+)/);
    if (t) this.launches.push(Number(t[1]));
  }
  // Only the nodes of the app's own package count: the keyboard and system bars belong to other packages.
  async dump() {
    for (let i = 0; i < 4; i++) {
      try {
        const raw = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
        const xml = raw.slice(raw.indexOf('<?xml'), raw.lastIndexOf('</hierarchy>') + 12);
        if (xml.length > 20) { this.lastXml = xml; return parseDump(xml).filter((n) => n.pkg === this.pkg); }
      } catch {}
      await sleep(400);
    }
    this.lastXml = ''; return [];
  }
  tap([x, y]) { adb('shell', 'input', 'tap', String(x), String(y)); }
  longPress([x, y]) { adb('shell', 'input', 'swipe', String(x), String(y), String(x), String(y), '900'); }
  key(k) { adb('shell', 'input', 'keyevent', k); }
  text(t) { adb('shell', 'input', 'text', t.replace(/ /g, '%s').replace(/([&|;<>()$`\\"'*?\[\]{}!~#])/g, '\\$1')); }
  swipe(x1, y1, x2, y2, ms = 250) { adb('shell', 'input', 'swipe', ...[x1, y1, x2, y2, ms].map(String)); }
  screenshot(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, adbBuf('exec-out', 'screencap', '-p')); }
  setConfig(sizeName, theme) {
    const s = SIZES[sizeName];
    adb('shell', 'wm', 'size', s.size); adb('shell', 'wm', 'density', String(s.density));
    adb('shell', 'cmd', 'uimode', 'night', theme === 'dark' ? 'yes' : 'no');
    this.density = s.density;
  }
  resetConfig() { adb('shell', 'wm', 'size', 'reset'); adb('shell', 'wm', 'density', 'reset'); adb('shell', 'cmd', 'uimode', 'night', 'auto'); }
  // Dump until two dumps in a row show the same texts (the screen stopped changing), at most ~8 s.
  async stable(minNodes = 3) {
    const key = (ns) => ns.map((n) => n.text + '|' + n.desc).join('\n');
    let prev = null, nodes = [];
    for (let i = 0; i < 16; i++) {
      nodes = await this.dump();
      if (nodes.length >= minNodes && prev !== null && key(nodes) === prev) return nodes;
      prev = nodes.length >= minNodes ? key(nodes) : null;
      await sleep(500);
    }
    return nodes;
  }
  async settle() { await sleep(600); return this.stable(); }
  // Fresh start, then optionally replay a list of recorded taps.
  async reopen(steps = []) {
    this.launch();
    let nodes = await this.settle();
    for (const s of steps) { s.long ? this.longPress(s.at) : this.tap(s.at); await sleep(500); nodes = await this.stable(1); }
    return nodes;
  }
  // The control a person means by this name: accessible name or text, exact first.
  find(nodes, name, { editable = false } = {}) {
    const lc = name.toLowerCase();
    const pool = nodes.filter((n) => n.bounds[2] > n.bounds[0]);
    const eq = (n) => n.text === name || n.desc === name;
    const has = (n) => n.text.toLowerCase().includes(lc) || n.desc.toLowerCase().includes(lc);
    const edit = (n) => /EditText|TextField/.test(n.cls);
    for (const test of [(n) => eq(n) && (!editable || edit(n)), (n) => has(n) && (!editable || edit(n)), eq, has]) {
      const hit = pool.find(test);
      if (hit) { let t = hit; while (!t.clickable && t.parent >= 0 && nodes[t.parent]) t = nodes[t.parent]; return t.clickable ? t : hit; }
    }
    return null;
  }
  async runStep(step) {
    if ('open' in step) { this.launch(); await this.settle(); }
    else if ('click' in step) { const n = this.find(await this.dump(), step.click); if (!n) throw new Error(`nothing found by name or text: ${step.click}`); this.tap(center(n)); await sleep(900); }
    else if ('type' in step) {
      const n = this.find(await this.dump(), step.type.into, { editable: true }) || this.find(await this.dump(), step.type.into);
      if (!n) throw new Error(`nothing found by name or text: ${step.type.into}`);
      this.tap(center(n)); await sleep(400); this.text(step.type.text); await sleep(400);
    }
    else if ('press' in step) { const k = step.press; this.key(/^\d+$/.test(k) ? k : 'KEYCODE_' + k.toUpperCase().replace(/^BACK$/, 'BACK')); await sleep(500); }
    else if ('wait' in step) await sleep(step.wait);
    else if ('failRequest' in step) this.proxy.fail(step.failRequest);
    else if ('slowRequest' in step) this.proxy.slow(step.slowRequest.match, step.slowRequest.ms);
    else throw new Error(`unknown step ${JSON.stringify(step)}`);
  }
}

// Start and stop an Electron app named by run.json, in an isolated profile, with the same network rules as the web adapter.
// run.json: { platform: "electron", dir?, install?, build?, launch: { executablePath?, args?, schemes? } }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import { redactUrl, redactHeaders, scrub, sleep, locate, runStep } from '../web/context.mjs';

const DEAD_PROXY = '127.0.0.1:9';
const ENV_ALLOW = ['PATH', 'DISPLAY', 'XAUTHORITY', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG', 'LANGUAGE'];
export const SIZES = { narrow: { w: 1024, h: 700 }, wide: { w: 1440, h: 900 } };

// dir is relative: to work/ next to run.json, or, for a file named rebuild-run.json, to that file's own folder.
export function workDirOf(run, appFile) {
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  const base = path.basename(appFile) === 'rebuild-run.json' ? path.dirname(appFile) : path.join(path.dirname(appFile), 'work');
  const workDir = path.resolve(base, run.dir || '.');
  if (path.relative(base, workDir).startsWith('..')) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  return workDir;
}

// install and build run once per process, and not at all when a parent already did (RR_PREPARED=1). Returns { workDir, buildMs }.
const prepared = new Map();
export function prepareApp(run, appFile) {
  const workDir = workDirOf(run, appFile);
  if (prepared.has(workDir)) return prepared.get(workDir);
  let buildMs = null;
  if (process.env.RR_PREPARED !== '1') {
    if (run.install) execSync(run.install, { cwd: workDir, stdio: 'inherit' });
    if (run.build) { const t = Date.now(); execSync(run.build, { cwd: workDir, stdio: 'inherit' }); buildMs = Date.now() - t; }
  }
  const r = { workDir, buildMs };
  prepared.set(workDir, r);
  return r;
}

export const kindOf = (title) => String(title || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim() || 'untitled';
const blank = (s) => s.replace(/\d{1,2}:\d{2}(:\d{2})?(\s?[ap]m)?/gi, '#').replace(/\d+/g, '#');
export async function signature(page) {
  const snap = await page.locator('body').ariaSnapshot();
  return crypto.createHash('sha1').update(blank(snap)).digest('hex').slice(0, 10);
}

// Runs in the main process (serialized by Playwright, so it must not use anything from this file).
const stubDialogs = ({ dialog }) => {
  globalThis.__rrDialogs = [];
  const answers = {
    showOpenDialog: { canceled: true, filePaths: [] }, showSaveDialog: { canceled: true, filePath: '' },
    showMessageBox: { response: 0, checkboxChecked: false }, showCertificateTrustDialog: undefined,
    showOpenDialogSync: undefined, showSaveDialogSync: undefined, showMessageBoxSync: 0, showErrorBox: undefined,
  };
  for (const [name, answer] of Object.entries(answers)) {
    dialog[name] = (...a) => {
      const o = a.find((x) => x && typeof x === 'object' && !x.webContents) || {};
      globalThis.__rrDialogs.push({ method: name, title: String(o.title || (typeof a[0] === 'string' ? a[0] : '')) });
      return name.endsWith('Sync') || name === 'showErrorBox' ? answer : Promise.resolve(answer);
    };
  }
};
// Returns { app, page, rec, faults, windows, dialogs, setTheme, setSize, stop, buildMs }.
// faults (mutable): { slowMs: delay every fetch/xhr, failApi: answer every fetch/xhr with 500 }
export async function launchApp(run, appFile, { theme = 'light' } = {}) {
  const { workDir, buildMs } = prepareApp(run, appFile);
  const l = run.launch || {};
  const tmp = fs.mkdtempSync(path.join(process.env.RR_TMP_ROOT || os.tmpdir(), 'rr-electron-'));
  const d = Object.fromEntries(['home', 'profile', 'ext', 'appdata', 'localappdata', 'xdg-config', 'xdg-cache', 'xdg-data', 'claude'].map((n) => [n, path.join(tmp, n)]));
  for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
  const env = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^LC_/.test(k)) env[k] = process.env[k];
  Object.assign(env, {
    HOME: d.home, USERPROFILE: d.home, APPDATA: d.appdata, LOCALAPPDATA: d.localappdata,
    XDG_CONFIG_HOME: d['xdg-config'], XDG_CACHE_HOME: d['xdg-cache'], XDG_DATA_HOME: d['xdg-data'], CLAUDE_CONFIG_DIR: d.claude,
    HTTP_PROXY: `http://${DEAD_PROXY}`, HTTPS_PROXY: `http://${DEAD_PROXY}`, http_proxy: `http://${DEAD_PROXY}`, https_proxy: `http://${DEAD_PROXY}`,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1',
  });
  const executablePath = l.executablePath ? path.resolve(workDir, l.executablePath) : createRequire(path.join(workDir, 'package.json'))('electron');
  const args = [...(l.args || ['.']), `--user-data-dir=${d.profile}`, `--extensions-dir=${d.ext}`, `--proxy-server=${DEAD_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1;[::1]'];

  let pid = 0, stopped = false;
  const cleanup = () => { try { if (pid) process.kill(pid, 'SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  process.on('exit', cleanup);
  let app;
  try {
    app = await _electron.launch({ executablePath, args, cwd: workDir, env, timeout: 30000 });
  } catch (e) {
    cleanup();
    process.off('exit', cleanup);
    throw new Error(`could not start the Electron app: ${scrub(e.message).split('\n')[0]}. An app built with the EnableNodeCliInspectArguments fuse turned off cannot be driven this way.`);
  }
  pid = app.process().pid;

  // Paths of this machine never go into the files: the app's folder becomes <app>, the temp profile <profile>, the home folder <home>.
  const swaps = [[pathToFileURL(workDir).href, 'file:///<app>'], [workDir, '<app>'], [fs.realpathSync(workDir), '<app>'], [tmp, '<profile>'], [fs.realpathSync(tmp), '<profile>'], [os.homedir(), '<home>']];
  const clean = (v) => { let x = String(v); for (const [a, b] of swaps) x = x.split(a).join(b); return scrub(x); };
  const rec = { blocked: [], har: [], console: [], pageErrors: [], main: [] };
  for (const [stream, tag] of [[app.process().stdout, 'stdout'], [app.process().stderr, 'stderr']]) {
    let buf = '';
    stream.on('data', (c) => { buf += c; const lines = buf.split('\n'); buf = lines.pop(); for (const x of lines) if (x.trim()) rec.main.push(clean(`${tag} ${x}`)); });
  }
  const ownSchemes = new Set(['file:', 'data:', 'blob:', 'about:', ...(l.schemes || []).map((s) => (s.endsWith(':') ? s : `${s}:`))]);
  const allowed = (raw) => {
    try { const u = new URL(raw); return ownSchemes.has(u.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch { return false; }
  };
  const faults = {};
  const context = app.context();
  await context.route('**/*', async (route) => {
    if (!allowed(route.request().url())) { rec.blocked.push(clean(redactUrl(route.request().url()))); return route.abort('blockedbyclient'); }
    return route.fallback();
  });
  await context.route('**/*', async (route) => {
    if (!['fetch', 'xhr'].includes(route.request().resourceType()) || !(faults.slowMs || faults.failApi)) return route.fallback();
    if (faults.slowMs) await sleep(faults.slowMs);
    if (faults.failApi) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated failure"}' });
    return route.fallback();
  });
  context.on('requestfinished', async (req) => {
    try {
      const res = await req.response();
      rec.har.push({
        startedDateTime: new Date(req.timing().startTime || Date.now()).toISOString(),
        time: Math.round(req.timing().responseEnd || 0),
        request: { method: req.method(), url: clean(redactUrl(req.url())), headers: redactHeaders(await req.allHeaders()) },
        response: { status: res.status(), headers: redactHeaders(await res.allHeaders()) },
      });
    } catch {}
  });

  const windows = [];
  const watch = (page) => {
    if (windows.includes(page)) return;
    windows.push(page);
    page.on('console', (m) => m.type() === 'error' && rec.console.push(clean(m.text())));
    page.on('pageerror', (e) => rec.pageErrors.push(clean(e.message)));
    page.on('close', () => { const i = windows.indexOf(page); if (i >= 0) windows.splice(i, 1); });
  };
  app.on('window', watch);
  // If this process is killed with SIGKILL no exit handler runs, so a small watcher outside it removes the app and its profile folder.
  // The folder reaches the watcher through its environment, not its command line, so killing by that folder does not kill the watcher first.
  spawn(process.execPath, ['--input-type=module', '-e', WATCHER, String(process.pid), String(app.process().pid)], { detached: true, stdio: 'ignore', env: { ...process.env, RR_WATCH_DIR: tmp } }).unref();
  const page = await app.firstWindow({ timeout: 30000 }).catch(async (e) => { await stopNow(); throw new Error(`the app opened no window: ${scrub(e.message).split('\n')[0]}`); });
  app.windows().forEach(watch);

  await app.evaluate(stubDialogs);
  const setTheme = (t) => app.evaluate(({ nativeTheme }, v) => { nativeTheme.themeSource = v; }, t);
  await setTheme(theme);
  // Resizes the window holding p; returns the content size the window ended up with (a window may refuse).
  const setSize = async (p, w, h) => {
    const win = await app.browserWindow(p);
    return win.evaluate((bw, [a, b]) => { bw.setContentSize(a, b); return bw.getContentSize(); }, [w, h]);
  };
  const dialogs = () => app.evaluate(() => globalThis.__rrDialogs || []).catch(() => []);

  async function stopNow() {
    if (stopped) return;
    stopped = true;
    if (app) { try { await Promise.race([app.close(), sleep(5000)]); } catch {} }
    cleanup();
    process.off('exit', cleanup);
  }
  const session = { app, page, rec, faults, windows, dialogs, setTheme, setSize, stop: stopNow, buildMs, tmp };
  return session;
}

// The window whose title kind matches, waiting for it to open.
export async function windowOfKind(session, kind, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    for (const w of session.windows) { if (!w.isClosed() && kindOf(await w.title().catch(() => '')) === kind) return w; }
    if (Date.now() > end) throw new Error(`no window of kind "${kind}" opened`);
    await sleep(150);
  }
}

// Replays states.json steps. { open: "<window kind>" } picks the window, the rest are the shared steps.
export async function replay(session, steps, settleMs = 300) {
  for (const step of steps) {
    if ('open' in step) session.page = await windowOfKind(session, step.open);
    else { await runStep(session.page, null, step); if ('click' in step || 'type' in step || 'press' in step) await sleep(settleMs); }
  }
}

// open(screen, { width, height, colorScheme }) for runProbes and measureScreens: a fresh isolated launch.
// go() replays the screen's steps; session.page is the window of the screen only after go().
export function electronOpener(run, appFile) {
  return async (screen, { width = SIZES.wide.w, height = SIZES.wide.h, colorScheme = 'light' } = {}) => {
    const session = await launchApp(run, appFile, { theme: colorScheme });
    await session.setSize(session.page, width, height).catch(() => {});
    return {
      get page() { return session.page; },
      rec: session.rec, faults: session.faults, close: () => session.stop(),
      go: async () => { await replay(session, screen.steps || []); await session.setSize(session.page, width, height).catch(() => {}); },
    };
  };
}

const WATCHER = `
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const [owner, app] = process.argv.slice(1).map(Number); const dir = process.env.RR_WATCH_DIR;
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
while (alive(owner) && alive(app)) await new Promise((r) => setTimeout(r, 400));
if (alive(app)) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(app)]);
  else { spawnSync('pkill', ['-KILL', '-f', dir]); try { process.kill(app, 'SIGKILL'); } catch {} }
}
await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
`;

// Kills any process whose command line contains marker (the app's profile folder lives under it) and removes the folder.
export function killByMarker(marker) {
  if (process.platform === 'win32') spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
  else spawnSync('pkill', ['-KILL', '-f', marker]);
  try { fs.rmSync(marker, { recursive: true, force: true }); } catch {}
}

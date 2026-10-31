// Electron parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Runs every <dir>/F-*.test.mjs as its own `node --test` process with APP_RUN set to the run file. A test launches its own
// isolated copy of the app with launchApp from launch.mjs, so no app is shared between tests. Results: a list of { feature, passed, detail }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchApp, prepareApp, killByMarker } from './launch.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const testsDir = path.resolve(arg('tests') || '');
const out = path.resolve(arg('out') || '');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'electron') throw new Error(`electron adapter cannot run parity for platform "${run.platform}"`);
const here = path.dirname(new URL(import.meta.url).pathname);

// Install and build once; the tests then skip them (RR_PREPARED). One launch measures how long a launch takes:
// each test gets 60 s, or the launch time plus 60 s when the launch alone takes longer than that.
prepareApp(run, appFile);
const t0 = Date.now();
await (await launchApp(run, appFile)).stop();
const launchMs = Date.now() - t0;
const limit = launchMs > 60000 ? launchMs + 60000 : 60000;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-parity-'));
const results = [];
for (const file of fs.readdirSync(testsDir).filter((f) => /^F-.*\.test\.mjs$/.test(f)).sort()) {
  const r = spawnSync(process.execPath, ['--test', path.join(testsDir, file)], {
    cwd: here,
    env: { ...process.env, APP_RUN: appFile, RR_PREPARED: '1', RR_TMP_ROOT: root, NODE_PATH: path.join(here, 'node_modules') },
    encoding: 'utf8', timeout: limit, killSignal: 'SIGKILL',
  });
  killByMarker(path.join(root, 'rr-electron-')); // an app a killed test left behind
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  results.push({ feature: file.replace(/\.test\.mjs$/, ''), passed: r.status === 0 && !timedOut, detail: (timedOut ? [`timed out after ${limit / 1000} s`, ...text] : text).slice(-20).join('\n') });
}
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
process.exit(0);

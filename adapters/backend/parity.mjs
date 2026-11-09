// Backend parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Runs every <dir>/F-*.test.mjs as its own `node --test` process. A test gets APP_RUN (the run file), API_MODULE (the absolute path of api.mjs)
// and APP_URL (the address; plain fetch reaches it only in proxy mode, where the service is not in its own network namespace).
// It imports prepare, call and restart from api.mjs and calls the service through them; call starts the service when it is not running. Results: a list of { feature, passed, detail }.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare } from './api.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const testsDir = path.resolve(arg('tests') || '');
const out = path.resolve(arg('out') || '');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'backend') throw new Error(`backend adapter cannot run parity for platform "${run.platform}"`);
const here = path.dirname(fileURLToPath(import.meta.url));

// Install and build once; the tests then skip them (RR_PREPARED).
const pctx = prepare(run, appFile);
// One baseline of untracked files for the whole run, taken before the first test, so each test's fresh start removes what earlier tests left.
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-backend-baseline-'));
const baselineFile = path.join(baseDir, 'baseline.json');
fs.writeFileSync(baselineFile, JSON.stringify(pctx.baseline ? [...pctx.baseline] : null));
const results = [];
const TIMEOUT_MS = 120000;
// Each test runs in its own process group with its own temp parent (RR_TMP_PARENT, used by start); both are removed afterwards.
function runTest(file) {
  return new Promise((resolve) => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-backend-parity-'));
    const child = spawn(process.execPath, ['--test', '--test-force-exit', path.join(testsDir, file)], {
      cwd: here, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APP_RUN: appFile, API_MODULE: path.join(here, 'api.mjs'), APP_URL: run.address, RR_PREPARED: '1', RR_BASELINE: baselineFile, RR_TMP_PARENT: tmpParent },
    });
    let output = '', timedOut = false, done = false;
    const take = (d) => { output = (output + d).slice(-20000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    let ended = false;
    child.on('exit', () => { ended = true; });
    const killGroup = () => {
      // Only a process that has not ended is signalled by its number; the services still listed in the file are the ones whose own exit the test never saw (it removes a line when its child ends).
      if (!ended) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      // The services a test started have their own process groups; start lists them in <tmpParent>/groups.
      try { for (const l of fs.readFileSync(path.join(tmpParent, 'groups'), 'utf8').split('\n')) if (l) { try { process.kill(-Number(l), 'SIGKILL'); } catch {} } } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, TIMEOUT_MS);
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer); killGroup();
      fs.rmSync(tmpParent, { recursive: true, force: true });
      resolve({ status, timedOut, text: output.trim().split('\n') });
    };
    child.on('error', (e) => { output += String(e.message); finish(1); });
    child.on('close', (code) => finish(code));
  });
}
for (const file of fs.readdirSync(testsDir).filter((f) => /^F-.*\.test\.mjs$/.test(f)).sort()) {
  const r = await runTest(file);
  results.push({ feature: file.replace(/\.test\.mjs$/, ''), passed: r.status === 0 && !r.timedOut, detail: (r.timedOut ? ['timed out after 120 s', ...r.text] : r.text).slice(-20).join('\n') });
}
fs.rmSync(baseDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
process.exit(0);

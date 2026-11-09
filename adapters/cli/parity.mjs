// CLI parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Runs every <dir>/F-*.test.mjs as its own `node --test` process. A test gets APP_RUN (the run file) and CLI_RUN_MODULE (the absolute path of run.mjs)
// and imports prepare and runCli from it. Results: a list of { feature, passed, detail }.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepare } from './run.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const testsDir = path.resolve(arg('tests') || '');
const out = path.resolve(arg('out') || '');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'cli') throw new Error(`cli adapter cannot run parity for platform "${run.platform}"`);
const here = path.dirname(fileURLToPath(import.meta.url));

// Install and build once; the tests then skip them (RR_PREPARED).
prepare(run, appFile);
const results = [];
const TIMEOUT_MS = 120000;
// Each test runs in its own process group with its own temp parent (RR_TMP_PARENT, used by runCli); both are removed afterwards.
function runTest(file) {
  return new Promise((resolve) => {
    const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-parity-'));
    const child = spawn(process.execPath, ['--test', path.join(testsDir, file)], {
      cwd: here, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, APP_RUN: appFile, CLI_RUN_MODULE: path.join(here, 'run.mjs'), RR_PREPARED: '1', RR_TMP_PARENT: tmpParent },
    });
    let output = '', timedOut = false, done = false;
    const take = (d) => { output = (output + d).slice(-20000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
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
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
process.exit(0);

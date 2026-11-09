// CLI parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Runs every <dir>/F-*.test.mjs as its own `node --test` process. A test gets APP_RUN (the run file) and CLI_RUN_MODULE (the absolute path of run.mjs)
// and imports prepare and runCli from it. Results: a list of { feature, passed, detail }.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
for (const file of fs.readdirSync(testsDir).filter((f) => /^F-.*\.test\.mjs$/.test(f)).sort()) {
  const r = spawnSync(process.execPath, ['--test', path.join(testsDir, file)], {
    cwd: here,
    env: { ...process.env, APP_RUN: appFile, CLI_RUN_MODULE: path.join(here, 'run.mjs'), RR_PREPARED: '1' },
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  results.push({ feature: file.replace(/\.test\.mjs$/, ''), passed: r.status === 0 && !timedOut, detail: (timedOut ? ['timed out after 60 s', ...text] : text).slice(-20).join('\n') });
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
process.exit(0);

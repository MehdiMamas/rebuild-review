// Web parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Starts the app, runs every <dir>/F-*.test.mjs as its own `node --test` process with APP_URL set, stops the app.
// Results: a list of { feature, passed, detail }. Tests import Playwright by absolute path from this folder's node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startApp } from './app.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const testsDir = path.resolve(arg('tests') || '');
const out = path.resolve(arg('out') || '');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'web') throw new Error(`web adapter cannot run parity for platform "${run.platform}"`);
const { origin, stop } = await startApp(run, appFile);

const results = [];
for (const file of fs.readdirSync(testsDir).filter((f) => /^F-.*\.test\.mjs$/.test(f)).sort()) {
  const r = spawnSync('node', ['--test', path.join(testsDir, file)], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, APP_URL: origin, NODE_PATH: path.join(path.dirname(new URL(import.meta.url).pathname), 'node_modules') },
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  results.push({ feature: file.replace(/\.test\.mjs$/, ''), passed: r.status === 0 && !timedOut, detail: (timedOut ? ['timed out after 60 s', ...text] : text).slice(-20).join('\n') });
}
stop();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
process.exit(0);

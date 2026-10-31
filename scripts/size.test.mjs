import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { measure, plan } from './size.mjs';

const scale = JSON.parse(fs.readFileSync(new URL('../scale.json', import.meta.url), 'utf8'));
function repo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-size-test-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
  execFileSync('git', ['add', '-A'], { cwd: d });
  return d;
}
const lines = (n) => 'x\n'.repeat(n);

test('a small repo gets the floors', () => {
  const d = repo({ 'a.js': lines(100), 'b.css': lines(20) });
  const size = measure(d);
  assert.equal(size.lines, 120);
  const p = plan(size, scale);
  assert.equal(p.units, 1);
  assert.deepEqual([p.buildUsd, p.stackUsd, p.loopUsd, p.maxScreens, p.maxButtons], [25, 3, 50, 30, 10]);
});

test('a large synthetic size scales every budget up', () => {
  const p = plan({ lines: 500000 }, scale);
  assert.equal(p.units, 25);
  assert.ok(p.buildUsd > 25 && p.loopUsd > 50 && p.maxScreens > 30 && p.maxButtons > 10);
  assert.ok(p.estimateUsd.high > p.estimateUsd.low);
  assert.equal(plan({ lines: 20001 }, scale).units, 2);
  assert.equal(plan({ lines: 0 }, scale).units, 1);
});

test('vendored, generated, lock and non-source files are skipped; every file is counted or listed', () => {
  const files = {
    'src/app.ts': lines(10), 'src/ui.tsx': lines(5),
    'node_modules/dep/index.js': lines(1000), 'vendor/lib.py': lines(1000),
    'dist/bundle.js': lines(1000), 'src/app.min.js': lines(1000), 'src/gen/api.generated.ts': lines(1000),
    'package-lock.json': lines(1000), 'yarn.lock': lines(1000), 'logo.png': 'bin', 'README.md': lines(50),
  };
  const size = measure(repo(files));
  assert.equal(size.lines, 15);
  assert.equal(size.counted, 2);
  assert.deepEqual(size.byLanguage, { typescript: 15 });
  assert.equal(size.counted + size.skipped.length, size.files);
  assert.equal(size.files, Object.keys(files).length);
  const why = Object.fromEntries(size.skipped.map((s) => [s.path, s.reason]));
  assert.equal(why['node_modules/dep/index.js'], 'vendored');
  assert.equal(why['vendor/lib.py'], 'vendored');
  assert.equal(why['dist/bundle.js'], 'generated');
  assert.equal(why['src/app.min.js'], 'generated');
  assert.equal(why['src/gen/api.generated.ts'], 'generated');
  assert.equal(why['package-lock.json'], 'lock file');
  assert.equal(why['yarn.lock'], 'lock file');
  assert.equal(why['logo.png'], 'not source');
});

// ---- step 2: estimate before spending ----
import { readPlan, checkBudget, addCost } from './size.mjs';
const SIZE_CLI = new URL('./size.mjs', import.meta.url).pathname;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-size-run-'));
const runCli = (...a) => spawnSync('node', [SIZE_CLI, ...a], { encoding: 'utf8' });
import { spawnSync } from 'node:child_process';

test('readPlan gives the floors without size.json and the scaled plan with it', () => {
  const run = tmp();
  assert.equal(readPlan(run).buildUsd, 25);
  const big = repo({ 'a.js': lines(450000) });
  assert.equal(runCli(big, run).status, 0);
  assert.ok(readPlan(run).buildUsd > 25 && readPlan(run).loopUsd > 50);
});

test('a maxUsd below the high estimate refuses with exit 3 and the estimate; at or above it passes', () => {
  const run = tmp(), big = repo({ 'a.js': lines(450000) });
  const high = plan(measure(big), scale).estimateUsd.high;
  const no = runCli(big, run, '--max-usd', String(high - 1));
  assert.equal(no.status, 3);
  assert.match(no.stdout, /Nothing was spent/);
  assert.match(no.stdout, new RegExp(`\\$${high}`));
  assert.equal(runCli(big, run, '--max-usd', String(high)).status, 0);
  assert.equal(runCli(big, run, '--max-usd', 'abc').status, 3);
  assert.equal(runCli(big, run).status, 0); // no flag: only prints the estimate
  assert.equal(checkBudget(plan({ lines: 10 }, scale), undefined).ok, false);
});

test('addCost sums spend per phase and the total', () => {
  const run = tmp();
  addCost(run, 'Stack', 1.5);
  addCost(run, 'Rebuild', 4);
  const c = addCost(run, 'Rebuild', 2);
  assert.deepEqual(c.phases, { Stack: { usd: 1.5, runs: 1 }, Rebuild: { usd: 6, runs: 2 } });
  assert.equal(c.totalUsd, 7.5);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'cost.json'), 'utf8')), c);
});

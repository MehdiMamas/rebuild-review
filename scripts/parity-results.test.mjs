import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kinds, wrongTests, settle, merge, failing, cleanDetail, readCost, loop, MAX_ROUNDS, LOOP_USD } from './parity-results.mjs';

const md = '# Features\n\nF-001 keep. Page.\n- **F-002 defect.** No loading\nF-003 Keep: shortcut\nsome other line\n';
const res = (o) => Object.entries(o).map(([feature, passed]) => ({ feature, passed, detail: '' }));

test('kinds reads keep and defect, and throws on an ID line with neither', () => {
  assert.deepEqual(kinds(md), { 'F-001': 'keep', 'F-002': 'defect', 'F-003': 'keep' });
  assert.throws(() => kinds('F-004 something else\n'));
});

test('a defect test that passes on the original is wrong (the F-012 case); a failing keep test too', () => {
  assert.deepEqual(wrongTests(res({ 'F-001': false, 'F-002': true, 'F-003': true }), kinds(md)), ['F-001', 'F-002']);
});

test('settle moves wrong and flaky tests, notes them, rewrites original.json; merge writes parity.json', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  fs.mkdirSync(path.join(t, 'tests'));
  for (const id of ['F-001', 'F-002', 'F-003']) fs.writeFileSync(path.join(t, 'tests', `${id}.test.mjs`), '');
  fs.writeFileSync(path.join(t, 'features.md'), md + 'F-004 defect. Not tested\n');
  fs.writeFileSync(path.join(t, 'untested.md'), 'F-004: not visible\n');
  fs.writeFileSync(path.join(t, 'original.json'), JSON.stringify(res({ 'F-001': true, 'F-002': true, 'F-003': true })));
  fs.writeFileSync(path.join(t, 'original-2.json'), JSON.stringify(res({ 'F-001': true, 'F-002': true, 'F-003': false })));
  settle(t, path.join(t, 'features.md'));
  assert.deepEqual(fs.readdirSync(path.join(t, 'tests')), ['F-001.test.mjs']);
  assert.deepEqual(fs.readdirSync(path.join(t, 'removed')).sort(), ['F-002.test.mjs', 'F-003.test.mjs']);
  const un = fs.readFileSync(path.join(t, 'untested.md'), 'utf8');
  assert.match(un, /F-002: wrong test/);
  assert.match(un, /F-003: flaky/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t, 'original.json'), 'utf8')).map((r) => r.feature), ['F-001']);
  const out = merge(t, path.join(t, 'features.md'));
  assert.deepEqual(out.map((o) => [o.feature, o.original]), [['F-001', 'pass'], ['F-002', 'not run'], ['F-003', 'not run'], ['F-004', 'not run']]);
  fs.rmSync(t, { recursive: true, force: true });
});

// ---- the loop ----
const feat = 'F-001 keep. A\nF-002 defect. B\nF-003 keep. C\nF-004 keep. D\n';
function runFixture({ rebuild, rounds = [], builds = [{ n: 1, cost: 1 }], err } = {}) {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-'));
  const par = path.join(run, 'parity');
  fs.mkdirSync(par); fs.mkdirSync(path.join(run, 'rebuild')); fs.mkdirSync(path.join(run, 'project'));
  fs.writeFileSync(path.join(run, 'features.md'), feat);
  fs.writeFileSync(path.join(par, 'untested.md'), 'F-004: not visible\n');
  if (rebuild) fs.writeFileSync(path.join(par, 'rebuild.json'), JSON.stringify(Object.entries(rebuild).map(([feature, passed]) => ({ feature, passed, detail: passed ? '' : `bad ${feature}` }))));
  if (rounds.length) fs.writeFileSync(path.join(par, 'rounds.json'), JSON.stringify(rounds.map((failing, i) => ({ round: i + 1, build: i + 1, failing, costUsd: 0 }))));
  if (err) fs.writeFileSync(path.join(par, 'run-error.txt'), err);
  for (const b of builds) fs.writeFileSync(path.join(run, 'rebuild', `build-${b.n}.result.json`), JSON.stringify({ ok: true, costUsd: b.cost }));
  return { run, par, md: path.join(run, 'features.md') };
}

test('failing counts a missing result, keeps defect, skips untested features', () => {
  const f = runFixture({ rebuild: { 'F-001': true, 'F-002': false } });
  assert.deepEqual(failing(f.par, f.md).map((x) => x.feature), ['F-002', 'F-003']);
  assert.equal(failing(f.par, f.md)[1].detail, 'no result for this feature');
});

test('cleanDetail drops stack lines, hides POSIX and Windows paths, keeps a URL, caps at 15 lines', () => {
  const t = cleanDetail('Error: expected 1\n    at Foo (/home/x/y.mjs:3:4)\nopen /home/x/y.mjs failed\nat C:\\Users\\x\\a.js\nfile C:\\Users\\x\\a.js and D:/w/b.js\nsee http://127.0.0.1:3000/api/tasks ok\nin /tmp/par/tests', '/tmp/par');
  assert.equal(t, 'Error: expected 1\nopen <path> failed\nfile <path> and <path>\nsee http://127.0.0.1:3000/api/tasks ok\nin <path>/tests');
  assert.equal(cleanDetail(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')).split('\n').length, 15);
});

test('readCost sums build results only and finds the highest build number', () => {
  const f = runFixture({ builds: [{ n: 1, cost: 2 }, { n: 3, cost: 4.5 }] });
  fs.writeFileSync(path.join(f.run, 'rebuild', 'stack-1.result.json'), JSON.stringify({ costUsd: 99 }));
  assert.deepEqual(readCost(f.run), { spent: 6.5, build: 3 });
});

test('loop: done when nothing fails; builds otherwise and writes rounds.json and failures.md', () => {
  let f = runFixture({ rebuild: { 'F-001': true, 'F-002': true, 'F-003': true } });
  assert.deepEqual(loop(f.par, f.md, f.run), { action: 'done', reason: 'all tested features pass', failing: [] });
  f = runFixture({ rebuild: { 'F-001': true, 'F-002': false, 'F-003': true } });
  const out = loop(f.par, f.md, f.run);
  assert.equal(out.action, 'build'); assert.deepEqual(out.failing, ['F-002']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.par, 'rounds.json'), 'utf8')), [{ round: 1, build: 1, failing: ['F-002'], costUsd: 1 }]);
  assert.equal(fs.readFileSync(path.join(f.par, 'failures.md'), 'utf8'), '## F-002 (defect)\nbad F-002\n');
});

test('loop: stop with no progress after 2 rounds that did not improve, and restores the best project', () => {
  const f = runFixture({ rebuild: { 'F-001': false, 'F-002': false, 'F-003': true }, rounds: [['F-001'], ['F-001', 'F-002']], builds: [{ n: 1, cost: 1 }, { n: 2, cost: 1 }, { n: 3, cost: 1 }] });
  fs.writeFileSync(path.join(f.run, 'project', 'v'), '3');
  fs.mkdirSync(path.join(f.run, 'rebuild', 'project-from-build-1'));
  fs.writeFileSync(path.join(f.run, 'rebuild', 'project-from-build-1', 'v'), '1');
  const out = loop(f.par, f.md, f.run);
  assert.deepEqual(out, { action: 'stop', reason: 'no progress', failing: ['F-001', 'F-002'], restored: 1 });
  assert.equal(fs.readFileSync(path.join(f.run, 'project', 'v'), 'utf8'), '1');
  assert.equal(fs.readFileSync(path.join(f.run, 'rebuild', 'project-from-build-3', 'v'), 'utf8'), '3');
});

test('loop: a tie picks the later build, so nothing is restored', () => {
  const f = runFixture({ rebuild: { 'F-001': false, 'F-002': true, 'F-003': true }, rounds: [['F-001'], ['F-001']], builds: [{ n: 1, cost: 1 }, { n: 2, cost: 1 }, { n: 3, cost: 1 }] });
  fs.mkdirSync(path.join(f.run, 'rebuild', 'project-from-build-1'));
  const out = loop(f.par, f.md, f.run);
  assert.equal(out.action, 'stop'); assert.equal(out.restored, undefined);
});

test('loop: stop on budget and on rounds', () => {
  let f = runFixture({ rebuild: { 'F-001': false, 'F-002': true, 'F-003': true }, builds: [{ n: 1, cost: LOOP_USD }] });
  assert.equal(loop(f.par, f.md, f.run).reason, 'budget');
  f = runFixture({ rebuild: { 'F-001': false, 'F-002': true, 'F-003': true }, rounds: Array.from({ length: MAX_ROUNDS - 1 }, (_, i) => Array.from({ length: MAX_ROUNDS - i }, (_, j) => `x${j}`)) });
  const out = loop(f.par, f.md, f.run);
  assert.deepEqual([out.action, out.reason], ['stop', 'rounds']);
});

test('loop: run-error.txt makes every tested feature fail with that text', () => {
  const f = runFixture({ err: 'app did not start' });
  const out = loop(f.par, f.md, f.run);
  assert.deepEqual(out.failing, ['F-001', 'F-002', 'F-003']);
  assert.match(fs.readFileSync(path.join(f.par, 'failures.md'), 'utf8'), /## F-001 \(keep\)\napp did not start/);
});

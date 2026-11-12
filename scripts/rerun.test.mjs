import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { PHASES } from './rerun.mjs';

const RERUN = new URL('./rerun.mjs', import.meta.url).pathname;
const LONG = new URL('./long-run.mjs', import.meta.url).pathname;
const WORKFLOW = fs.readFileSync(new URL('../workflows/rebuild-review.js', import.meta.url), 'utf8');

const put = (root, rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const run = (...args) => spawnSync(process.execPath, [RERUN, ...args], { encoding: 'utf8' });
const ls = (d) => fs.readdirSync(d).sort();
const tree = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? tree(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]).sort();

// A finished run folder.
function fixture({ markers = PHASES.concat(['Foundations']), parity = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-'));
  put(root, 'run.json', '{"platform":"web"}');
  put(root, 'features.md');
  put(root, 'golden/manifest.json');
  put(root, 'inventory/states.json');
  put(root, 'project/rebuild-run.json', '{"address":"http://127.0.0.1:1"}');
  put(root, 'project/src/app.js', 'code');
  put(root, 'rebuild/build-1.result.json');
  put(root, 'cost.json', '{}');
  put(root, 'size.json', '{}');
  put(root, 'base.json', '{}');
  for (const p of markers) put(root, `${p}.done`, '');
  put(root, 'InventoryFound.done', '');
  if (parity) {
    for (const f of ['rounds.json', 'loop-stop.txt', 'failures.md', 'original.json', 'rebuild.json', 'run-error.txt', 'visual-diff.json', 'parity.json']) put(root, `parity/${f}`, f);
    put(root, 'parity/tests/F-001.test.mjs');
    put(root, 'parity/areas/all.done');
    put(root, 'parity/removed/F-009.test.mjs');
    put(root, 'parity/untested.md');
    put(root, 'parity/untested-extra.md');
    put(root, 'golden-rebuild/manifest.json');
  }
  put(root, 'score/score.json', 'old score');
  put(root, 'report/index.html', 'old report');
  put(root, 'report/stopped.txt', 'stopped');
  return root;
}
const done = (root) => ls(root).filter((n) => n.endsWith('.done'));
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const exists = (...p) => fs.existsSync(path.join(...p));

test('given a run folder with project/ and Rebuild.done and --from Parity -> Parity, Score and Report markers are removed, Rebuild and project are untouched', () => {
  const root = fixture();
  const before = tree(path.join(root, 'project'));
  const r = run(root, '--from', 'Parity');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(done(root), ['Capture.done', 'Foundations.done', 'Inventory.done', 'InventoryFound.done', 'Rebuild.done', 'Stack.done']);
  assert.deepEqual(tree(path.join(root, 'project')), before);
  assert.ok(exists(root, 'golden/manifest.json') && exists(root, 'cost.json') && exists(root, 'size.json') && exists(root, 'base.json'));
  assert.deepEqual(tree(path.join(root, 'rebuild')), ['build-1.result.json']);
  assert.match(r.stdout, /"from":"Parity"/);
  cleanup(root);
});

test('given --from Score -> only Score.done and Report.done are removed and parity/ is not moved', () => {
  const root = fixture();
  const parBefore = tree(path.join(root, 'parity'));
  const r = run(root, '--from', 'Score');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(done(root).filter((n) => !['Capture.done', 'Inventory.done', 'Stack.done', 'Rebuild.done', 'Parity.done', 'Foundations.done', 'InventoryFound.done'].includes(n)), []);
  assert.ok(exists(root, 'Parity.done') && !exists(root, 'Score.done') && !exists(root, 'Report.done'));
  assert.deepEqual(tree(path.join(root, 'parity')), parBefore);
  assert.ok(exists(root, 'golden-rebuild/manifest.json'));
  assert.ok(exists(root, 'previous-1/score/score.json') && exists(root, 'previous-1/report/index.html'));
  cleanup(root);
});

test('given --from Report -> only Report.done is removed', () => {
  const root = fixture();
  const r = run(root, '--from', 'Report');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(root, 'Score.done') && exists(root, 'Parity.done') && !exists(root, 'Report.done'));
  assert.ok(exists(root, 'score/score.json'), 'score is kept for --from Report');
  assert.ok(exists(root, 'previous-1/report/index.html') && !exists(root, 'report'));
  assert.ok(!exists(root, 'previous-1/score'));
  cleanup(root);
});

test('given a run folder with no Rebuild.done or no project/rebuild-run.json -> refuses with a plain reason, exit 2, nothing removed or moved', () => {
  for (const gone of ['Rebuild.done', 'project/rebuild-run.json', 'features.md', 'golden']) {
    const root = fixture();
    fs.rmSync(path.join(root, gone), { recursive: true });
    const before = tree(root);
    const r = run(root, '--from', 'Parity');
    assert.equal(r.status, 2, gone);
    assert.match(r.stderr, new RegExp(`missing .*${gone.replace('.', '\\.')}`));
    assert.deepEqual(tree(root), before, `nothing changed when ${gone} is missing`);
    cleanup(root);
  }
  const root = fixture();
  fs.rmSync(path.join(root, 'parity/parity.json'));
  const r = run(root, '--from', 'Score');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /parity\/parity\.json/);
  cleanup(root);
});

test('given an unknown --from value or a missing runDir -> refuses with usage, exit 2', () => {
  const root = fixture();
  const before = tree(root);
  for (const args of [[root, '--from', 'Stack'], [root, '--from', 'parity'], [root], [], ['--from', 'Parity'], [path.join(root, 'nope'), '--from', 'Parity'], [root, '--from', 'Parity', '--bogus']]) {
    const r = run(...args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage|not found|must be one of/);
  }
  assert.deepEqual(tree(root), before);
  cleanup(root);
});

test('given parity/ holding rounds.json, loop-stop.txt, failures.md, results and tests/ -> the results go to previous-1/, tests, areas, removed and untested files stay', () => {
  const root = fixture();
  const r = run(root, '--from', 'Parity');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ls(path.join(root, 'parity')), ['areas', 'removed', 'tests', 'untested-extra.md', 'untested.md']);
  assert.deepEqual(ls(path.join(root, 'previous-1/parity')), ['failures.md', 'loop-stop.txt', 'original.json', 'parity.json', 'rebuild.json', 'rounds.json', 'run-error.txt', 'visual-diff.json']);
  assert.ok(exists(root, 'previous-1/golden-rebuild/manifest.json') && !exists(root, 'golden-rebuild'));
  assert.ok(exists(root, 'previous-1/score/score.json') && exists(root, 'previous-1/report/stopped.txt'));
  assert.ok(!exists(root, 'report') && !exists(root, 'score'));
  cleanup(root);
});

test('given a second rerun -> results go to previous-2, previous-1 is not overwritten or nested, and rounds start at 1', () => {
  const root = fixture();
  assert.equal(run(root, '--from', 'Parity').status, 0);
  put(root, 'Parity.done', ''); put(root, 'parity/rounds.json', 'second'); put(root, 'parity/parity.json', 'second');
  assert.equal(run(root, '--from', 'Parity').status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'previous-1/parity/rounds.json'), 'utf8'), 'rounds.json');
  assert.equal(fs.readFileSync(path.join(root, 'previous-2/parity/rounds.json'), 'utf8'), 'second');
  assert.ok(!exists(root, 'previous-2/previous-1') && !exists(root, 'parity/previous-1') && !exists(root, 'previous-1/previous-2'));
  assert.ok(!exists(root, 'parity/rounds.json'), 'no old rounds left for the loop to count');
  cleanup(root);
});

test('given parity/ holding nothing movable and no other results -> no empty previous-<n> folder is made', () => {
  const root = fixture({ parity: false });
  fs.rmSync(path.join(root, 'score'), { recursive: true });
  fs.rmSync(path.join(root, 'report'), { recursive: true });
  put(root, 'parity/tests/F-001.test.mjs');
  put(root, 'parity/untested.md');
  const r = run(root, '--from', 'Parity');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ls(root).filter((n) => n.startsWith('previous-')), []);
  assert.match(r.stdout, /"previous":null/);
  cleanup(root);
});

test('given a run with no Parity.done yet (unfinished) -> allowed, nothing to remove for the missing markers, no error', () => {
  const root = fixture({ markers: ['Capture', 'Inventory', 'Stack', 'Rebuild'] });
  const r = run(root, '--from', 'Parity');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.split('\n')[0]).removed, []);
  assert.ok(exists(root, 'Rebuild.done'));
  cleanup(root);
});

test('given a live supervisor (.pid alive, no .exit) -> refuses, nothing moved', () => {
  const root = fixture();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  put(root, 'long/parity-build-1.pid', String(child.pid));
  const before = tree(root);
  const r = run(root, '--from', 'Parity');
  child.kill();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /still running/);
  assert.deepEqual(tree(root), before);
  // a finished command (exit file) or a dead pid does not block
  put(root, 'long/parity-build-1.exit', '0');
  assert.equal(run(root, '--from', 'Parity').status, 0);
  cleanup(root);
});

test('given a rerun right after a finished run -> stale long/*.exit files do not block it, and start restarts a name with an old exit file', () => {
  const root = fixture();
  const dir = path.join(root, 'long');
  const start = (...cmd) => spawnSync(process.execPath, [LONG, 'start', dir, 'parity-rebuild-run-1', '--', ...cmd], { encoding: 'utf8' });
  assert.equal(start(process.execPath, '-e', 'process.exit(0)').status, 0);
  for (let i = 0; i < 100 && !exists(dir, 'parity-rebuild-run-1.exit'); i++) spawnSync('sleep', ['0.1']);
  assert.ok(exists(dir, 'parity-rebuild-run-1.exit'));
  assert.equal(run(root, '--from', 'Parity').status, 0);
  const again = JSON.parse(start(process.execPath, '-e', 'setTimeout(() => process.exit(5), 300)').stdout);
  assert.equal(again.attached, false, 'a finished name starts fresh');
  const w = JSON.parse(spawnSync(process.execPath, [LONG, 'wait', dir, 'parity-rebuild-run-1', '--seconds', '20'], { encoding: 'utf8' }).stdout);
  assert.equal(w.state, 'exited');
  assert.equal(w.code, 5, 'the old exit file is gone, the new exit code is read');
  cleanup(root);
});

test('given --from Parity after a finished run -> score/ and report/ are moved so no old score shows beside the new parity', () => {
  const root = fixture();
  assert.equal(run(root, '--from', 'Parity').status, 0);
  assert.ok(!exists(root, 'score') && !exists(root, 'report'));
  assert.equal(fs.readFileSync(path.join(root, 'previous-1/score/score.json'), 'utf8'), 'old score');
  cleanup(root);
});

test('given --no-build -> NoBuild.done is written; a later rerun without it removes it', () => {
  const root = fixture();
  const r = run(root, '--from', 'Parity', '--no-build');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(root, 'NoBuild.done'));
  assert.ok(done(root).includes('NoBuild.done') && done(root).includes('Rebuild.done'));
  put(root, 'parity/parity.json', '{}');
  assert.equal(run(root, '--from', 'Score').status, 0);
  assert.ok(!exists(root, 'NoBuild.done'));
  cleanup(root);
});

test('rerun redoes Parity, Score and Report without a rebuild: the markers left are the earlier phases, project/ keeps its files, rebuild/ gains none', () => {
  const root = fixture();
  const proj = tree(path.join(root, 'project'));
  const reb = tree(path.join(root, 'rebuild'));
  assert.equal(run(root, '--from', 'Parity', '--no-build').status, 0);
  assert.deepEqual(done(root), ['Capture.done', 'Foundations.done', 'Inventory.done', 'InventoryFound.done', 'NoBuild.done', 'Rebuild.done', 'Stack.done']);
  assert.deepEqual(tree(path.join(root, 'project')), proj);
  assert.deepEqual(tree(path.join(root, 'rebuild')), reb);
  cleanup(root);
});

test('rerun appends one phase event "rerun from <Phase>"', () => {
  const root = fixture();
  assert.equal(run(root, '--from', 'Score').status, 0);
  const lines = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'phase');
  assert.equal(lines[0].reason, 'rerun from Score');
  cleanup(root);
});

test('given a failed move -> everything is rolled back and nothing changes', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'previous-1'), { recursive: true });
  fs.rmSync(path.join(root, 'previous-1'), { recursive: true });
  // a read-only run folder makes the rename into the new previous folder fail on the second source
  put(root, 'report/x', 'x');
  const before = tree(root);
  fs.chmodSync(path.join(root, 'report'), 0o555);
  const r = run(root, '--from', 'Report');
  fs.chmodSync(path.join(root, 'report'), 0o755);
  if (r.status === 0) { cleanup(root); return; } // running as a user that ignores permissions (root): cannot provoke the failure
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nothing was changed/);
  assert.deepEqual(tree(root), before);
  assert.ok(!exists(root, 'previous-1') && exists(root, 'Report.done'));
  cleanup(root);
});

test('rerun.mjs list of phases equals PHASES in the workflow', () => {
  const m = WORKFLOW.match(/^const PHASES = \[([^\]]*)\]/m);
  assert.ok(m, 'PHASES not found in the workflow');
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), PHASES);
});

test('given the workflow running with NoBuild.done and a failing rebuild suite -> loop-stop.txt says it was not rebuilt, and no build call is reachable (workflow text)', () => {
  const noBuild = WORKFLOW.indexOf("d.action === 'build' && done.has('NoBuild.done')");
  const build = WORKFLOW.indexOf('longRun(`parity-build-');
  assert.ok(noBuild > 0 && build > 0, 'both found');
  assert.ok(noBuild < build, 'the NoBuild branch comes before the build call');
  const branch = WORKFLOW.slice(noBuild, build);
  assert.match(branch, /not rebuilt: NoBuild\.done is set/);
  assert.match(branch, /\bbreak\b/);
  // the break leaves the loop through the same path as a stop: the Parity phase still finishes
  assert.ok(!/throw new Error/.test(branch));
});

test('given NoBuild.done set and a resumed workflow -> the marker is read from the .done list, so a resume still builds nothing', () => {
  assert.match(WORKFLOW, /const done = new Set\(\(listed && listed\.done\) \|\| \[\]\)/);
  assert.ok(WORKFLOW.indexOf("done.has('NoBuild.done')") > WORKFLOW.indexOf('const done = new Set'));
  assert.ok(!/ARGS\.noBuild/.test(WORKFLOW), 'no workflow argument carries it');
});

test('given NoBuild.done set -> the Estimate block is skipped so no maxUsd is needed', () => {
  const est = WORKFLOW.indexOf('// ---- Estimate');
  const guard = WORKFLOW.indexOf("if (!done.has('NoBuild.done')) {", est);
  const call = WORKFLOW.indexOf("label: 'estimate'", est);
  assert.ok(guard > est && guard < call, 'the estimate agent is inside the guard');
  assert.ok(call < WORKFLOW.indexOf('// ---- Inventory ----'));
});

test('given NoBuild.done unset -> the loop behaves as before: the build runs when the loop says build', () => {
  const noBuild = WORKFLOW.indexOf("d.action === 'build' && done.has('NoBuild.done')");
  const branch = WORKFLOW.slice(noBuild, WORKFLOW.indexOf("if (d.action !== 'build') {"));
  assert.equal((branch.match(/break/g) || []).length, 1, 'one break, only under the NoBuild condition');
  assert.match(WORKFLOW, /if \(d\.action !== 'build'\) \{/);
});

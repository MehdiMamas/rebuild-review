import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyLabels, delta, gate, totals, checkJudge, blind, labelsFor, seeded, measure, collate, gaps } from './score.mjs';

const rubricFile = new URL('../rubric.json', import.meta.url).pathname;
const rubric = JSON.parse(fs.readFileSync(rubricFile, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-score-test-'));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); };

test('delta: sign, floor and percent floor', () => {
  assert.equal(delta(200, 100, 'lower', 0), 0.5);          // rebuild faster: positive
  assert.equal(delta(100, 200, 'lower', 0), -0.5);         // rebuild slower: negative
  assert.equal(delta(100, 150, 'higher', 0), 1 / 3);       // higher is better, flipped
  assert.equal(delta(1000, 950, 'lower', 100), 0);         // under the floor
  assert.equal(delta(1000, 850, 'lower', 100), 0.15);      // over the floor
  assert.equal(delta(1000, 950, 'lower', '10%'), 0);       // 50 < 10% of 1000
  assert.equal(delta(1000, 800, 'lower', '10%'), 0.2);
  assert.equal(delta(0, 0, 'lower', 0), 0);
  assert.equal(delta(3, 0, 'lower', 0), 1);
});

test('a missing metric is listed as not measured and does not change the score', () => {
  const orig = { lcp: 1000, 'probe-failures': 4 }, reb = { lcp: 500, 'probe-failures': 2 };
  const a = totals(rubric, orig, reb, []);
  const b = totals(rubric, { ...orig, bytes: 9e6 }, reb, []); // bytes only on one side
  assert.deepEqual(a.values.speed.measured.map((m) => m.name), ['lcp']);
  assert.ok(a.values.speed.notMeasured.includes('bytes') && b.values.speed.notMeasured.includes('bytes'));
  assert.equal(a.overall, b.overall);
  assert.equal(a.values.speed.delta, 0.5);
});

test('weights add up and the overall runs from -100 to 100; judged and measured count half each', () => {
  const sum = Object.values(rubric.values).reduce((n, v) => n + v.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const all = (name, o, r) => ({ [name]: [o, r] });
  const o = {}, r = {};
  for (const v of Object.values(rubric.values)) for (const m of v.metrics) { o[m.name] = 100000; r[m.name] = 1; }
  assert.equal(totals(rubric, o, r, []).overall, 100);
  for (const v of Object.values(rubric.values)) for (const m of v.metrics) { o[m.name] = 1; r[m.name] = 100000; }
  assert.equal(totals(rubric, o, r, []).overall, -100);
  // ux: measured +1, judged -0.5 -> 0.25
  const t = totals(rubric, { 'probe-failures': 4 }, { 'probe-failures': 0 }, [{ value: 'ux', delta: -0.5 }]);
  assert.equal(t.values.ux.delta, 0.25);
  assert.equal(t.overall, 10);
  void all;
});

test('gate: 0.95 passes, 0.94 fails', () => {
  const mk = (pass, total) => Array.from({ length: total }, (_, i) => ({ feature: `F-${i}`, passed: i < pass }));
  assert.equal(gate(mk(95, 100), 0.95).passed, true);
  const g = gate(mk(94, 100), 0.95);
  assert.equal(g.passed, false);
  assert.equal(g.failing.length, 6);
  assert.equal(gate([], 0.95).passed, false);
});

test('check drops a missing file and a line past the end, keeps a metric name and a real line', () => {
  const d = tmp();
  put(path.join(d, 'A/source/a.js'), 'one\ntwo\nthree\n');
  put(path.join(d, 'A/measured.json'), { lcp: 1 });
  put(path.join(d, 'B/source/b.js'), 'x\n');
  put(path.join(d, 'B/measured.json'), { lcp: 2 });
  const item = (a, b) => ({ value: 'ux', question: 'q', A: { score: 5, cite: a }, B: { score: 6, cite: b } });
  const out = path.join(d, 'out.json');
  put(out, [item('A/source/a.js:3', 'lcp'), item('A/source/nope.js', 'B/source/b.js'), item('A/source/a.js:4', 'B/source/b.js:1'), item('B/source/b.js', 'B/source/b.js'), item('A/source/a.js:2', 'bogus-metric')]);
  const { kept, dropped } = checkJudge(out, d);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].A.cite, 'A/source/a.js:3');
  assert.deepEqual(dropped.map((x) => x.reason).sort(), ['file does not exist', 'file does not exist', 'file does not exist', 'line 4 past the end of the file'].sort());
});

test('a fixed shuffle maps A and B back correctly through collate', () => {
  const run = tmp();
  put(path.join(run, 'parity/rebuild.json'), [{ feature: 'F-001', passed: true }]);
  put(path.join(run, 'score/original.json'), {});
  put(path.join(run, 'score/rebuild.json'), {});
  const labels = labelsFor(4, seeded('fixed'));
  assert.deepEqual(labels, labelsFor(4, seeded('fixed')));
  assert.ok(labels.some((m) => m.A === 'original') && labels.some((m) => m.A === 'rebuild'));
  put(path.join(run, 'score/.labels.json'), { judges: labels });
  // Every judge scores "original" 3 and "rebuild" 7, written in its own A/B terms.
  labels.forEach((m, j) => put(path.join(run, `score/judge-${j}.json`), [{ value: 'ux', question: 'q', A: { score: m.A === 'rebuild' ? 7 : 3, cite: 'lcp' }, B: { score: m.B === 'rebuild' ? 7 : 3, cite: 'lcp' } }]));
  const r = collate(run, rubricFile);
  assert.equal(r.values.ux.judged.delta, 0.4);
  assert.equal(r.values.ux.judged.count, 4);
  assert.equal(gaps(run, rubricFile).filter((g) => g.kind === 'judged').length, 4);
  // A skeptic refutes one gap: it leaves the average and is listed.
  put(path.join(run, 'score/skeptic/j0-0.json'), { id: 'j0-0', refuted: true, why: 'cited line is a comment', cite: 'x' });
  const r2 = collate(run, rubricFile);
  assert.equal(r2.values.ux.judged.count, 3);
  assert.deepEqual(r2.refuted.map((x) => x.id), ['j0-0']);
});

test('measure: source counts from a walk, dependencies, build steps, worst per stem', () => {
  const d = tmp();
  put(path.join(d, 'src/package.json'), { dependencies: { a: '1', b: '1' }, devDependencies: { c: '1' } });
  put(path.join(d, 'src/a.js'), '1\n2\n3\n');
  put(path.join(d, 'src/b.js'), '1\n');
  put(path.join(d, 'src/package-lock.json'), '{}');
  put(path.join(d, 'src/node_modules/x/i.js'), 'x');
  put(path.join(d, 'src/logo.png'), 'a\0b');
  put(path.join(d, 'g/timings.json'), [{ name: 'root.lcp', value: 100 }, { name: 'a.lcp', value: 300 }, { name: 'inp-ms', value: 20 }, { name: 'root.load', value: 9 }]);
  put(path.join(d, 'g/probes.json'), [{ passed: false }, { passed: true }, { passed: false }]);
  put(path.join(d, 'g/a11y-violations.json'), [{ screen: 'root', violations: [{ id: 'label', nodes: 2 }, { id: 'x', nodes: 1 }] }]);
  put(path.join(d, 'run.json'), { install: 'npm i && npm ci', build: 'npm run build' });
  const m = measure(path.join(d, 'src'), path.join(d, 'g'), { run: path.join(d, 'run.json') });
  assert.deepEqual(m, { lcp: 300, 'inp-ms': 20, 'probe-failures': 2, 'a11y-violations': 3, files: 3, lines: 5, 'longest-file': 3, dependencies: 3, 'build-steps': 3 });
});

test('blind leaves out .git, README, run files and stack.md, and keeps both sides apart', () => {
  const run = tmp(), root = tmp();
  put(path.join(run, 'run.json'), { dir: 'app' });
  put(path.join(run, 'work/app/src/x.js'), 'orig\n');
  put(path.join(run, 'work/app/README.md'), 'secret original');
  put(path.join(run, 'work/app/.git/config'), 'x');
  put(path.join(run, 'project/rebuild-run.json'), { dir: '.' });
  put(path.join(run, 'project/src/x.js'), 'reb\n');
  put(path.join(run, 'project/stack.md'), 'stack');
  put(path.join(run, 'project/node_modules/q.js'), 'q');
  put(path.join(run, 'golden/screens/root/1440-light.png'), 'png');
  put(path.join(run, 'golden-rebuild/screens/root/1440-light.png'), 'png');
  put(path.join(run, 'score/original.json'), { lines: 1 });
  put(path.join(run, 'score/rebuild.json'), { lines: 1 });
  const { folder, judges } = blind(run, 3, { seed: 'k', root });
  assert.equal(judges.length, 3);
  const all = fs.readdirSync(folder, { recursive: true });
  for (const bad of ['.git', 'README', 'rebuild-run.json', 'run.json', 'stack.md', 'node_modules']) assert.ok(!all.some((f) => f.includes(bad)), bad);
  judges.forEach((m, j) => {
    for (const l of ['A', 'B']) assert.equal(fs.readFileSync(path.join(folder, `judge-${j}`, l, 'source/src/x.js'), 'utf8'), m[l] === 'original' ? 'orig\n' : 'reb\n');
  });
  assert.ok(!all.some((f) => f.includes('labels')));
});

test('verifyLabels catches a mis-copied label map', () => {
  const run = tmp(), root = tmp();
  put(path.join(run, 'run.json'), { dir: 'app' });
  put(path.join(run, 'work/app/x.js'), 'orig\n');
  put(path.join(run, 'project/rebuild-run.json'), { dir: '.' });
  put(path.join(run, 'project/x.js'), 'reb\n');
  const { folder, judges } = blind(run, 3, { seed: 'v', root });
  assert.deepEqual(verifyLabels(run, folder, judges), []);
  const flipped = judges.map((m) => ({ A: m.B, B: m.A }));
  assert.equal(verifyLabels(run, folder, flipped).length, 6);
});

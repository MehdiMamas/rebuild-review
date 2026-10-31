import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wilsonLower, phi, coverage, agreement, margin, trackRecord, confidence } from './confidence.mjs';

const rubric = {
  verdict: { adoptOverall: 15, worseValue: -0.15, betterValue: 0.15 },
  confidence: { spreadZero: 0.5, noiseOverall: 10, noiseValue: 0.1, outsideRangeCap: 30 },
  values: { speed: { metrics: [{ name: 'lcp' }, { name: 'bytes' }] }, ux: { metrics: [{ name: 'probe-failures' }], question: 'q' } },
};
const w = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(t)); };
const m = (name, original = 1) => ({ name, original, rebuild: 1, delta: 0 });
const goodScore = (over = {}) => ({
  gate: { passed: true, rate: 1, failing: [] }, overall: 40, dropped: [], refuted: [],
  values: {
    speed: { delta: 0.5, measured: [m('lcp'), m('bytes')], judged: { delta: null, count: 0 }, judges: [], notMeasured: [] },
    ux: { delta: 0.5, measured: [m('probe-failures')], judged: { delta: 0.5, count: 3 }, judges: [0.5, 0.5, 0.5], notMeasured: [] },
  }, ...over,
});
const parityAll = (n, notRun = 0) => Array.from({ length: n }, (_, i) => ({ feature: `F-${i}`, kind: 'keep', original: i < notRun ? 'not run' : 'pass', rebuild: i < notRun ? 'not run' : 'pass', note: '' }));
function run({ score = goodScore(), parity = parityAll(10), coverageJson } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-test-'));
  if (score) w(path.join(d, 'score/score.json'), score);
  if (parity) w(path.join(d, 'parity/parity.json'), parity);
  if (coverageJson) w(path.join(d, 'golden/coverage.json'), coverageJson);
  return d;
}
const record = (n, k) => Array.from({ length: n }, (_, i) => ({ kind: 'same', expected: 'leave', got: 'leave', right: i < k, sourceLines: 300 }));

test('wilsonLower against values worked out by hand', () => {
  // 6 of 6: centre (1 + 1.96^2/12)/(1 + 1.96^2/6) = 0.80480, half-width 1.96*sqrt(1.96^2/144)/(1.64027) = 0.19518
  assert.ok(Math.abs(wilsonLower(6, 6) - 0.6097) < 0.0005);
  assert.ok(Math.abs(wilsonLower(10, 20) - 0.2993) < 0.0005);
  assert.ok(Math.abs(wilsonLower(1, 2) - 0.0945) < 0.0005);
  assert.equal(wilsonLower(0, 5), 0);
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(60, 60) > wilsonLower(6, 6)); // more runs, higher bound
});

test('phi', () => { assert.ok(Math.abs(phi(0) - 0.5) < 1e-6); assert.ok(Math.abs(phi(1) - 0.8413) < 1e-3); assert.ok(Math.abs(phi(-1) - 0.1587) < 1e-3); });

test('coverage multiplies features and metrics; untested and not-run count against it', () => {
  const d = run({ parity: parityAll(10, 5), score: goodScore() });
  const c = coverage(d, rubric);
  assert.equal(c.inputs.featuresCompared, 5);
  assert.equal(c.inputs.featuresFound, 10);
  assert.equal(c.inputs.metricsMeasured, 3);
  assert.equal(c.percent, 50);
  assert.match(c.left.join(), /no golden\/coverage\.json/);
  const half = run({ score: goodScore({ values: { speed: { delta: 0, measured: [m('lcp')] }, ux: { delta: 0, measured: [m('probe-failures')] } } }) });
  assert.ok(Math.abs(coverage(half, rubric).percent - 66.7) < 0.1);
});

test('coverage uses screens reached out of seen when coverage.json exists', () => {
  const c = coverage(run({ coverageJson: { screensReached: 3, screensCutOff: 1, buttonsSkipped: 4 } }), rubric);
  assert.equal(c.inputs.screensReached, 3);
  assert.equal(c.inputs.screensSeen, 4);
  assert.equal(c.inputs.buttonsSkipped, 4);
  assert.equal(c.percent, 75);
  assert.deepEqual(c.left, []);
});

test('low coverage caps the total and is named', () => {
  const d = run({ parity: parityAll(10, 9) });
  const r = confidence(d, { rubric, calibration: record(100, 100) });
  assert.equal(r.limitedBy, 'coverage');
  assert.equal(r.percent, 10);
});

test('a big judge spread lowers agreement', () => {
  const calm = agreement(run(), rubric).percent;
  const wild = goodScore(); wild.values.ux.judges = [-0.4, 0.5, 0.9];
  const a = agreement(run({ score: wild }), rubric);
  assert.equal(calm, 100);
  assert.equal(a.percent, 0);
  const mild = goodScore(); mild.values.ux.judges = [0.4, 0.5, 0.6];
  assert.equal(agreement(run({ score: mild }), rubric).percent, 60);
});

test('refuted and dropped judge items lower agreement and are shown', () => {
  const s = goodScore({ refuted: [{ value: 'ux', id: 'j0-0' }], dropped: [{ reason: 'x' }, { reason: 'y' }] }); // 3 kept + 1 refuted, 2 dropped
  const a = agreement(run({ score: s }), rubric);
  assert.equal(a.inputs.refuted, 1);
  assert.equal(a.inputs.judgeItemsDropped, 2);
  assert.ok(Math.abs(a.percent - 100 * (3 / 4) * (4 / 6)) < 0.1);
});

test('a result on a threshold reads about 50', () => {
  const on = margin(goodScore({ overall: 15, values: { speed: { delta: 0.15 }, ux: { delta: 0.3 } } }), rubric);
  assert.ok(Math.abs(on.percent - 50) < 0.1, String(on.percent));
  const far = margin(goodScore({ overall: 45, values: { speed: { delta: 0.5 }, ux: { delta: 0.5 } } }), rubric);
  assert.ok(far.percent > 99);
  assert.equal(far.perValue.speed > 99, true);
  assert.equal(on.inputs.noiseUnitsFromIt, 0);
});

test('margin with no score is 0 and says why', () => { const x = margin(null, rubric); assert.equal(x.percent, 0); assert.match(x.left[0], /no score/); });

test('empty calibration gives a low cap, not an error', () => {
  const t = trackRecord([]);
  assert.equal(t.percent, 0);
  assert.match(t.left[0], /no known-answer runs/);
  const r = confidence(run(), { rubric, calibration: [] });
  assert.equal(r.percent, 0);
  assert.equal(r.limitedBy, 'track record');
  assert.ok(Math.abs(trackRecord(record(6, 6)).percent - 61) < 0.1);
});

test('wrong verdicts count against the track record', () => { assert.ok(trackRecord(record(6, 4)).percent < trackRecord(record(6, 6)).percent); });

test('no score gives not measured', () => {
  const r = confidence(run({ score: null }), { rubric, calibration: record(6, 6) });
  assert.equal(r.percent, null);
  assert.equal(r.text, 'not measured');
});

test('a target over the calibrated range is capped and says so', () => {
  const big = goodScore(); big.values.simplicity = { delta: 0, measured: [{ name: 'lines', original: 5000, rebuild: 5000, delta: 0 }] };
  const r = confidence(run({ score: big }), { rubric, calibration: record(100, 100) });
  assert.equal(r.outsideRange, true);
  assert.equal(r.percent, 30);
  assert.equal(r.limitedBy, 'outside the calibrated range');
  const ok = goodScore(); ok.values.simplicity = { delta: 0, measured: [{ name: 'lines', original: 200, rebuild: 200, delta: 0 }] };
  assert.equal(confidence(run({ score: ok }), { rubric, calibration: record(100, 100) }).outsideRange, false);
});

test('size.json is used for the range check when present', () => {
  const d = run();
  w(path.join(d, 'size.json'), { lines: 9000 });
  assert.equal(confidence(d, { rubric, calibration: record(100, 100) }).outsideRange, true);
});

test('per-value percent comes from that value, not the total', () => {
  const s = goodScore(); s.values.ux.delta = 0.15; // on a threshold
  const r = confidence(run({ score: s }), { rubric, calibration: record(100, 100) });
  assert.ok(Math.abs(r.perValue.ux - 50) < 0.1);
  assert.ok(r.perValue.speed > 90);
});

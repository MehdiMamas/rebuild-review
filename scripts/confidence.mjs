// Confidence: how far the verdict can be trusted, as a percentage computed by code.
// It is the weakest of four parts (coverage, agreement, margin, track record), each 0 to 100, so one strong part cannot hide a bad one.
// It is not a calibrated probability; the track record part is what ties it to how often the tool was right on known answers.
// CLI: confidence.mjs <runDir>   writes score/confidence.json and prints it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tryJson = (f) => { try { return readJson(f); } catch { return null; } };
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_RUBRIC = path.join(HERE, '..', 'rubric.json');
const DEFAULT_CALIBRATION = path.join(HERE, '..', 'benchmark', 'calibration.json');
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const count = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);

// Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26 for erf).
export function phi(z) {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// Lower end of the 95% Wilson interval for k right out of n, as a fraction. No runs gives 0.
export function wilsonLower(k, n, z = 1.96) {
  if (!n) return 0;
  const p = k / n, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}

// ---- 1. coverage ----
export function coverage(runDir, rubric = tryJson(DEFAULT_RUBRIC)) {
  const inputs = {}, left = [];
  const factors = [];
  const parity = tryJson(path.join(runDir, 'parity', 'parity.json'));
  if (Array.isArray(parity) && parity.length) {
    const compared = parity.filter((f) => f.original !== 'not run' && f.rebuild !== 'not run').length;
    inputs.featuresCompared = compared; inputs.featuresFound = parity.length;
    factors.push(compared / parity.length);
  } else left.push('features (no parity result)');
  const score = tryJson(path.join(runDir, 'score', 'score.json'));
  const expected = Object.values((rubric && rubric.values) || {}).reduce((n, v) => n + (v.metrics || []).length, 0);
  if (score && score.values && expected) {
    const measured = Object.values(score.values).reduce((n, v) => n + (v.measured || []).length, 0);
    inputs.metricsMeasured = measured; inputs.metricsExpected = expected;
    factors.push(Math.min(1, measured / expected));
  }
  const cov = tryJson(path.join(runDir, 'golden', 'coverage.json'));
  if (cov) {
    const reached = count(cov.screensReached), cut = count(cov.screensCut);
    if (reached + cut > 0) { inputs.screensReached = reached; inputs.screensSeen = reached + cut; factors.push(reached / (reached + cut)); }
    else left.push('screens (golden/coverage.json has no screen counts)');
    if (cov.buttonsSkipped !== undefined) inputs.buttonsSkipped = count(cov.buttonsSkipped);
  } else left.push('screens (no golden/coverage.json)');
  const percent = factors.length ? clamp(100 * factors.reduce((a, b) => a * b, 1)) : 0;
  return { percent: r1(percent), inputs, left };
}

// ---- 2. agreement ----
// The weights of the three factors are judgement calls: they are multiplied with equal say.
function spreadFactor(deltas, zero) { return deltas.length < 2 ? null : clamp(1 - (Math.max(...deltas) - Math.min(...deltas)) / zero, 0, 1); }

export function agreement(runDir, rubric = tryJson(DEFAULT_RUBRIC)) {
  const score = tryJson(path.join(runDir, 'score', 'score.json'));
  const zero = ((rubric && rubric.confidence) || {}).spreadZero ?? 0.5;
  const inputs = {}, left = [], factors = [];
  const values = (score && score.values) || {};
  const spreads = Object.entries(values).map(([n, v]) => [n, spreadFactor(v.judges || [], zero), (v.judges || []).length ? Math.max(...v.judges) - Math.min(...v.judges) : null]).filter(([, f]) => f !== null);
  if (spreads.length) {
    inputs.judgeSpread = Object.fromEntries(spreads.map(([n, , s]) => [n, r1(s * 100) / 100]));
    factors.push(mean(spreads.map(([, f]) => f)));
  } else left.push('judge spread (fewer than two judges scored a value)');
  const kept = Object.values(values).reduce((n, v) => n + ((v.judged && v.judged.count) || 0), 0);
  const refuted = ((score && score.refuted) || []).length, dropped = ((score && score.dropped) || []).length;
  if (kept + refuted > 0) {
    inputs.judgedGaps = kept + refuted; inputs.refuted = refuted;
    factors.push(1 - refuted / (kept + refuted));
    inputs.judgeItemsKept = kept + refuted; inputs.judgeItemsDropped = dropped;
    factors.push((kept + refuted) / (kept + refuted + dropped));
  } else left.push('refuted and dropped shares (no judged items)');
  const perValue = {};
  for (const [n, f] of spreads) {
    const rf = ((score && score.refuted) || []).filter((r) => r.value === n).length, js = (values[n].judged && values[n].judged.count) || 0;
    perValue[n] = clamp(100 * f * (js + rf ? 1 - rf / (js + rf) : 1));
  }
  const percent = factors.length ? clamp(100 * factors.reduce((a, b) => a * b, 1)) : 0;
  return { percent: r1(percent), inputs, left, perValue };
}

// ---- 3. margin ----
// Distance from each threshold that could change the verdict, in units of noise; 0 units reads 50.
export function margin(score, rubric = tryJson(DEFAULT_RUBRIC)) {
  const t = (rubric && rubric.verdict) || {}, c = (rubric && rubric.confidence) || {};
  const noiseOverall = c.noiseOverall ?? 10, noiseValue = c.noiseValue ?? 0.1;
  const inputs = { noiseOverall, noiseValue }, perValue = {};
  if (!score || typeof score.overall !== 'number' || !score.values) return { percent: 0, inputs, left: ['margin (no score)'], perValue };
  const oz = Math.abs(score.overall - t.adoptOverall) / noiseOverall;
  inputs.overall = score.overall; inputs.adoptOverall = t.adoptOverall;
  let closest = { name: 'overall', z: oz };
  for (const [n, v] of Object.entries(score.values)) {
    if (typeof v.delta !== 'number') continue;
    const z = Math.min(Math.abs(v.delta - t.worseValue), Math.abs(v.delta - t.betterValue)) / noiseValue;
    perValue[n] = r1(100 * phi(z));
    if (z < closest.z) closest = { name: n, z };
  }
  inputs.closestThreshold = closest.name; inputs.noiseUnitsFromIt = r1(closest.z * 100) / 100;
  return { percent: r1(100 * phi(closest.z)), inputs, left: [], perValue };
}

// ---- 4. track record ----
export function trackRecord(calibration) {
  const runs = Array.isArray(calibration) ? calibration : [];
  const k = runs.filter((r) => r.right === true).length;
  return { percent: r1(100 * wilsonLower(k, runs.length)), inputs: { knownAnswerRuns: runs.length, rightVerdicts: k, biggestSourceLines: runs.length ? Math.max(...runs.map((r) => r.sourceLines || 0)) : 0 }, left: runs.length ? [] : ['track record (no known-answer runs)'] };
}

// ---- together ----
export function confidence(runDir, { rubric, calibration } = {}) {
  rubric = rubric || tryJson(DEFAULT_RUBRIC);
  calibration = calibration || tryJson(DEFAULT_CALIBRATION) || [];
  const score = tryJson(path.join(runDir, 'score', 'score.json'));
  if (!score || !score.values || typeof score.overall !== 'number') return { percent: null, text: 'not measured', limitedBy: null, parts: {}, perValue: {}, outsideRange: false };
  const parts = { coverage: coverage(runDir, rubric), agreement: agreement(runDir, rubric), margin: margin(score, rubric), 'track record': trackRecord(calibration) };
  let limitedBy = Object.keys(parts).reduce((a, b) => (parts[b].percent < parts[a].percent ? b : a));
  let percent = parts[limitedBy].percent;
  // Range check: size.json when present, else the original's measured line count.
  const size = tryJson(path.join(runDir, 'size.json'));
  const lines = size && size.size && typeof size.size.lines === 'number' ? size.size.lines : (score.values.simplicity && (score.values.simplicity.measured || []).find((m) => m.name === 'lines') || {}).original;
  const biggest = parts['track record'].inputs.biggestSourceLines;
  const cap = (rubric.confidence || {}).outsideRangeCap ?? 30;
  const outsideRange = typeof lines === 'number' && lines > biggest;
  parts['track record'].inputs.targetSourceLines = typeof lines === 'number' ? lines : null;
  if (outsideRange && cap < percent) { percent = cap; limitedBy = 'outside the calibrated range'; }
  const perValue = {};
  for (const n of Object.keys(score.values)) {
    const v = score.values[n], expected = ((rubric.values[n] || {}).metrics || []).length;
    const cov = expected ? 100 * Math.min(1, (v.measured || []).length / expected) : 100;
    const ps = [cov, parts.agreement.perValue[n], parts.margin.perValue[n]].filter((x) => typeof x === 'number');
    perValue[n] = ps.length ? r1(Math.min(...ps)) : null;
  }
  return { percent, limitedBy, parts, perValue, outsideRange, calibratedUpTo: biggest };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) { console.error('usage: confidence.mjs <runDir>'); process.exit(2); }
  const c = confidence(runDir);
  fs.mkdirSync(path.join(runDir, 'score'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'score', 'confidence.json'), JSON.stringify(c, null, 2));
  console.log(c.percent === null ? 'confidence: not measured' : `confidence ${c.percent}% (limited by ${c.limitedBy})`);
}

// Score phase: measure, blind, check, gaps, collate. Code does all the arithmetic; judges only supply cited scores.
// CLI: score.mjs measure <sourceDir> <goldenDir> <out.json> [--run run.json] [--rubric rubric.json]
//      score.mjs source <runDir> original|rebuild
//      score.mjs blind <runDir> <n> [--seed s] [--labels file]
//      score.mjs labels <runDir> <blindFolder> '<json of judges>'   (writes score/.labels.json after verifying it)
//      score.mjs check <answer.json> <judgeDir> <out.json>   (writes kept items to out.json, dropped ones beside it)
//      score.mjs gaps <runDir> <rubric.json>
//      score.mjs collate <runDir> <rubric.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { scan } from './size.mjs';
import { validate } from './areas.mjs';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const DEFAULT_RUBRIC = new URL('../rubric.json', import.meta.url).pathname;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// ---- deltas and totals ----
// Positive means the rebuild is better. Differences under the floor ("10%" of the larger side, or absolute) count as 0.
export function delta(original, rebuild, better, floor = 0) {
  const big = Math.max(Math.abs(original), Math.abs(rebuild));
  const abs = typeof floor === 'string' && floor.endsWith('%') ? (parseFloat(floor) / 100) * big : Number(floor) || 0;
  if (big === 0 || Math.abs(original - rebuild) < abs) return 0;
  return (better === 'higher' ? rebuild - original : original - rebuild) / big;
}

export function gate(passes, minPassRate) {
  // passes: [{feature, passed}] from the tests run on the rebuild
  const total = passes.length;
  const rate = total ? passes.filter((p) => p.passed).length / total : null;
  return { passed: rate !== null && rate >= minPassRate, rate, failing: passes.filter((p) => !p.passed).map((p) => p.feature) };
}

// judged: [{value, delta}] already unblinded and with refuted ones removed.
export function totals(rubric, original, rebuild, judged) {
  const values = {};
  let overall = 0;
  for (const [name, v] of Object.entries(rubric.values)) {
    const measured = [], notMeasured = [];
    for (const m of v.metrics || []) {
      const o = original[m.name], r = rebuild[m.name];
      if (typeof o !== 'number' || typeof r !== 'number') { notMeasured.push(m.name); continue; }
      measured.push({ name: m.name, original: o, rebuild: r, delta: round(delta(o, r, m.better, m.floor)) });
    }
    const js = v.question ? judged.filter((j) => j.value === name) : []; // a value with no question is measured only
    const parts = [];
    if (measured.length) parts.push(mean(measured.map((m) => m.delta)));
    if (js.length) parts.push(mean(js.map((j) => j.delta)));
    const d = parts.length ? mean(parts) : 0;
    values[name] = { delta: round(d), measured, judged: { delta: js.length ? round(mean(js.map((j) => j.delta))) : null, count: js.length }, notMeasured };
    overall += v.weight * d;
  }
  return { values, overall: round(overall * 100, 1) };
}

// ---- measure ----
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'coverage', '.cache', '.vite', '.turbo', '__pycache__']);
const LOCKS = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'pubspec.lock', 'poetry.lock', 'Gemfile.lock', 'bun.lockb', 'composer.lock']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|jar|class|so|dylib|dll|exe|mp3|mp4|mov|wasm|bin)$/i;
const isBinary = (f) => { if (BINARY_EXT.test(f)) return true; const b = fs.readFileSync(f).subarray(0, 8000); return b.includes(0); };

// Source files relative to dir: git ls-files when it lists something, else a walk.
export function listSource(dir) {
  let rel = [];
  try { rel = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch {}
  if (!rel.length) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : walk(path.join(d, e.name)).map((f) => path.join(e.name, f))) : [e.name]));
    rel = walk(dir);
  }
  return rel.filter((f) => !LOCKS.has(path.basename(f)) && !['run.json', 'rebuild-run.json'].includes(path.basename(f)) && fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).isFile() && !isBinary(path.join(dir, f))).sort();
}

const lineCount = (f) => { const t = fs.readFileSync(f, 'utf8'); return t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0); };

function countDependencies(dir) {
  let found = false, n = 0;
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? (found = true, fs.readFileSync(path.join(dir, f), 'utf8')) : null);
  const pkg = read('package.json');
  if (pkg) { const j = JSON.parse(pkg); n += Object.keys(j.dependencies || {}).length + Object.keys(j.devDependencies || {}).length; }
  const section = (text, header, end) => { // lines in a block that starts at header (yaml: indented children; toml: until next [table])
    let on = false, c = 0;
    for (const l of text.split('\n')) {
      if (header.test(l)) { on = true; continue; }
      if (on && end.test(l)) on = false;
      if (on && /^\s*[\w.-]+\s*[:=]/.test(l)) c++;
    }
    return c;
  };
  const pub = read('pubspec.yaml');
  if (pub) n += section(pub, /^(dev_)?dependencies:\s*$/, /^\S/);
  const req = read('requirements.txt');
  if (req) n += req.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  const cargo = read('Cargo.toml');
  if (cargo) n += section(cargo, /^\[(dev-|build-)?dependencies\]\s*$/, /^\[/);
  const gomod = read('go.mod');
  if (gomod) {
    let inBlock = false;
    for (const l of gomod.split('\n')) {
      if (/^require\s*\(/.test(l)) inBlock = true;
      else if (inBlock && l.startsWith(')')) inBlock = false;
      else if (inBlock && l.trim() && !l.trim().startsWith('//')) n++;
      else if (/^require\s+\S+/.test(l)) n++;
    }
  }
  return found ? n : null;
}

export function measure(sourceDir, goldenDir, { run, rubric = readJson(DEFAULT_RUBRIC) } = {}) {
  const out = {};
  const better = {};
  for (const v of Object.values(rubric.values)) for (const m of v.metrics || []) better[m.name] = m.better;
  const put = (name, value) => { if (name in better && typeof value === 'number' && Number.isFinite(value)) out[name] = value; };
  const tf = path.join(goldenDir, 'timings.json');
  if (fs.existsSync(tf)) {
    const worst = {};
    for (const t of readJson(tf)) {
      const stem = t.name.split('.').pop();
      if (typeof t.value !== 'number') continue;
      worst[stem] = stem in worst ? (better[stem] === 'higher' ? Math.min(worst[stem], t.value) : Math.max(worst[stem], t.value)) : t.value;
    }
    for (const [k, v] of Object.entries(worst)) put(k, v);
  }
  const pf = path.join(goldenDir, 'probes.json');
  if (fs.existsSync(pf)) put('probe-failures', readJson(pf).filter((p) => p.passed === false).length);
  const af = path.join(goldenDir, 'a11y-violations.json');
  if (fs.existsSync(af)) put('a11y-violations', readJson(af).reduce((n, r) => n + (r.violations || []).reduce((m, v) => m + (v.nodes || 0), 0), 0));
  if (fs.existsSync(sourceDir)) {
    const files = listSource(sourceDir);
    const counts = files.map((f) => lineCount(path.join(sourceDir, f)));
    put('files', files.length);
    put('lines', counts.reduce((a, b) => a + b, 0));
    put('longest-file', counts.length ? Math.max(...counts) : 0);
    put('dependencies', countDependencies(sourceDir));
  }
  if (run && fs.existsSync(run)) {
    const r = readJson(run);
    const steps = [r.install, r.build].filter(Boolean).flatMap((c) => c.split('&&')).map((c) => c.trim()).filter(Boolean);
    put('build-steps', steps.length);
  }
  return out;
}

// Where the app's source and run file are for each side of a run.
export function sourceOf(runDir, side) {
  if (side === 'original') {
    const runFile = path.join(runDir, 'run.json');
    return { runFile, source: path.resolve(runDir, 'work', readJson(runFile).dir || '.'), golden: path.join(runDir, 'golden') };
  }
  const runFile = path.join(runDir, 'project', 'rebuild-run.json');
  return { runFile, source: path.resolve(runDir, 'project', readJson(runFile).dir || '.'), golden: path.join(runDir, 'golden-rebuild') };
}

// ---- blind ----
const HIDE = (n) => n === 'run.json' || n === 'rebuild-run.json' || n === 'stack.md' || /^README/i.test(n);

// The first judge's labels are random; each next judge gets the opposite order, so both orders occur in every run.
export function labelsFor(n, rng) {
  const first = rng() < 0.5;
  return Array.from({ length: n }, (_, i) => ((first !== (i % 2 === 1)) ? { A: 'original', B: 'rebuild' } : { A: 'rebuild', B: 'original' }));
}
export function seeded(seed) { // mulberry32 from a hash of the seed
  let a = createHash('sha256').update(String(seed)).digest().readUInt32LE(0);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function blind(runDir, n, { seed = randomBytes(16).toString('hex'), root = os.tmpdir() } = {}) {
  const folder = fs.mkdtempSync(path.join(root, 'rr-judges-'));
  const judges = labelsFor(n, seeded(seed));
  const sides = { original: sourceOf(runDir, 'original'), rebuild: sourceOf(runDir, 'rebuild') };
  judges.forEach((map, i) => {
    for (const label of ['A', 'B']) {
      const real = sides[map[label]];
      const dest = path.join(folder, `judge-${i}`, label);
      fs.mkdirSync(path.join(dest, 'source'), { recursive: true });
      for (const f of listSource(real.source)) {
        if (f.split(path.sep).some(HIDE)) continue;
        fs.mkdirSync(path.dirname(path.join(dest, 'source', f)), { recursive: true });
        fs.copyFileSync(path.join(real.source, f), path.join(dest, 'source', f));
      }
      if (fs.existsSync(path.join(real.golden, 'screens'))) fs.cpSync(path.join(real.golden, 'screens'), path.join(dest, 'screens'), { recursive: true });
      else fs.mkdirSync(path.join(dest, 'screens'));
      const mf = path.join(runDir, 'score', `${map[label]}.json`);
      writeJson(path.join(dest, 'measured.json'), fs.existsSync(mf) ? readJson(mf) : {});
    }
  });
  return { folder, judges };
}

// Guard against a mis-copied label map: each judge side's source must equal the source of the side the map says it is.
// Where the two sides are identical either mapping is true. Returns the problems found.
export function verifyLabels(runDir, folder, judges) {
  const files = (side) => listSource(sourceOf(runDir, side).source).filter((f) => !f.split(path.sep).some(HIDE));
  const same = (side, dir) => {
    const real = sourceOf(runDir, side).source, want = files(side);
    const have = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : [];
    return JSON.stringify(want) === JSON.stringify(have) && want.every((f) => fs.readFileSync(path.join(real, f)).equals(fs.readFileSync(path.join(dir, f))));
  };
  const problems = [];
  judges.forEach((map, i) => {
    for (const label of ['A', 'B']) if (!same(map[label], path.join(folder, `judge-${i}`, label, 'source'))) problems.push(`judge-${i}/${label} is not the ${map[label]} source`);
  });
  return problems;
}

// ---- check ----
// A score stands only if its citation is a metric name in that side's measured.json, or a file under that side's folder
// (optionally file:line with a line that exists).
export function checkJudge(judgeOut, judgeDir) {
  const items = readJson(judgeOut);
  const kept = [], dropped = [];
  const measured = {};
  for (const side of ['A', 'B']) { const f = path.join(judgeDir, side, 'measured.json'); measured[side] = fs.existsSync(f) ? readJson(f) : {}; }
  const why = (side, cite) => {
    const c = String(cite || '').trim().replace(/^`|`$/g, '');
    if (!c) return 'no citation';
    const m = /^(?:\.\/)?(?:[AB]\/)?measured\.json:(.+)$/.exec(c);
    if (m) return m[1].trim() in measured[side] ? null : `no metric ${m[1]} in measured.json`;
    if (c in measured[side]) return null;
    const lm = /^(.*?):(\d+)$/.exec(c);
    let rel = lm ? lm[1] : c;
    if (rel.startsWith(`${side}/`)) rel = rel.slice(2);
    const root = path.resolve(judgeDir, side);
    const abs = path.resolve(root, rel);
    if (path.relative(root, abs).startsWith('..') || path.isAbsolute(path.relative(root, abs))) return 'path outside the folder';
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return 'file does not exist';
    if (lm) { const line = Number(lm[2]); if (line < 1 || line > lineCount(abs)) return `line ${line} past the end of the file`; }
    return null;
  };
  for (const it of Array.isArray(items) ? items : []) {
    const reasons = [];
    for (const side of ['A', 'B']) {
      const s = it && it[side];
      if (!s || typeof s.score !== 'number' || s.score < 0 || s.score > 10) { reasons.push({ side, reason: 'score missing or not 0 to 10' }); continue; }
      const r = why(side, s.cite);
      if (r) reasons.push({ side, reason: r, cite: s.cite });
    }
    if (typeof (it && it.value) !== 'string' || !reasons.length) { if (typeof (it && it.value) === 'string') kept.push(it); else dropped.push({ item: it, reason: 'no value' }); }
    else for (const r of reasons) dropped.push({ value: it.value, question: it.question, ...r });
  }
  return { kept, dropped };
}

// ---- gaps and collate ----
const GAP_POINTS = 3, GAP_DELTA = 0.5;

function load(runDir, rubricFile, area) {
  const rubric = readJson(rubricFile);
  const base = path.join(runDir, 'score');
  const sd = area ? path.join(base, 'areas', area) : base; // judge answers, dropped items and skeptic answers; the rest is shared
  const labelsFile = path.join(base, '.labels.json');
  const labels = fs.existsSync(labelsFile) ? readJson(labelsFile).judges : [];
  const original = readJson(path.join(base, 'original.json')), rebuild = readJson(path.join(base, 'rebuild.json'));
  const items = [];
  labels.forEach((map, j) => {
    const f = path.join(sd, `judge-${j}.json`);
    if (!fs.existsSync(f)) return;
    readJson(f).forEach((it, k) => {
      const score = (real) => it[map.A === real ? 'A' : 'B'];
      const o = score('original'), r = score('rebuild');
      items.push({ id: `${area ? area + '.' : ''}j${j}-${k}`, value: it.value, question: it.question, original: o, rebuild: r, points: r.score - o.score, delta: (r.score - o.score) / 10 });
    });
  });
  const dropped = [];
  if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd).filter((n) => /^judge-\d+\.dropped\.json$/.test(n))) dropped.push(...readJson(path.join(sd, f)));
  const skeptic = {};
  const sk = path.join(base, 'skeptic'); // ids carry the area prefix, so one folder serves all areas
  if (fs.existsSync(sk)) for (const f of fs.readdirSync(sk).filter((n) => n.endsWith('.json'))) { const r = readJson(path.join(sk, f)); skeptic[r.id] = r; }
  return { rubric, original, rebuild, items, dropped, skeptic };
}

// Area ids when areas.json holds more than one area; null otherwise (then every function below does exactly what it did before areas).
export function areaIds(runDir) {
  try { const a = readJson(path.join(runDir, 'areas.json')).areas; return Array.isArray(a) && a.length > 1 ? a.map((x) => x.id) : null; } catch { return null; }
}

// Counted source lines of each area of the original (the weight of its result); falls back to equal weights when nothing is counted.
export function areaWeights(runDir, ids) {
  const v = validate(readJson(path.join(runDir, 'areas.json')), scan(path.join(runDir, 'work')).counted);
  const lines = Object.fromEntries(v.areas.map((a) => [a.id, a.lines]));
  const total = ids.reduce((n, i) => n + (lines[i] || 0), 0);
  return Object.fromEntries(ids.map((i) => [i, { lines: lines[i] || 0, weight: total ? (lines[i] || 0) / total : 1 / ids.length }]));
}

// Combines per-area totals by weight. One part returns that part unchanged.
export function weigh(parts) {
  if (parts.length === 1) return { values: parts[0].values, overall: parts[0].overall };
  const sum = parts.reduce((n, p) => n + p.weight, 0) || 1;
  const values = {};
  for (const name of Object.keys(parts[0].values)) {
    const ds = parts.map((p) => p.values[name]);
    const w = (f) => round(ds.reduce((n, d, i) => n + parts[i].weight * f(d), 0) / sum);
    const counts = ds.reduce((n, d) => n + d.judged.count, 0);
    values[name] = { delta: w((d) => d.delta), measured: ds[0].measured, judged: { delta: counts ? round(ds.reduce((n, d, i) => n + parts[i].weight * (d.judged.delta ?? 0), 0) / sum) : null, count: counts }, notMeasured: ds[0].notMeasured };
  }
  return { values, overall: round(parts.reduce((n, p) => n + p.weight * p.overall, 0) / sum, 1) };
}

function gapsOf(loaded, withMetrics) {
  const { rubric, original, rebuild, items } = loaded;
  const out = items.filter((i) => Math.abs(i.points) >= GAP_POINTS).map((i) => ({ id: i.id, kind: 'judged', value: i.value, question: i.question, original: i.original, rebuild: i.rebuild }));
  if (withMetrics) {
    const { values } = totals(rubric, original, rebuild, []);
    for (const v of Object.values(values)) for (const m of v.measured) if (Math.abs(m.delta) >= GAP_DELTA) out.push({ id: `m-${m.name}`, kind: 'metric', ...m });
  }
  return out;
}

export function gaps(runDir, rubricFile) {
  const ids = areaIds(runDir);
  if (!ids) return gapsOf(load(runDir, rubricFile), true);
  return ids.flatMap((id, n) => gapsOf(load(runDir, rubricFile, id), n === 0)); // measured numbers are whole-app: their gaps are listed once
}

function collateOne(loaded) {
  const { rubric, original, rebuild, items, dropped, skeptic } = loaded;
  const refuted = items.filter((i) => skeptic[i.id] && skeptic[i.id].refuted === true).map((i) => ({ id: i.id, value: i.value, question: i.question, points: i.points, why: skeptic[i.id].why, cite: skeptic[i.id].cite }));
  const gone = new Set(refuted.map((r) => r.id));
  const t = totals(rubric, original, rebuild, items.filter((i) => !gone.has(i.id)));
  for (const v of Object.values(t.values)) for (const m of v.measured) { const s = skeptic[`m-${m.name}`]; if (s) m.note = s.refuted ? `skeptic doubts this: ${s.why}` : `skeptic agrees: ${s.why}`; }
  return { t, dropped, refuted };
}

export function collate(runDir, rubricFile) {
  const ids = areaIds(runDir);
  const parts = (ids || [undefined]).map((id) => ({ id, ...collateOne(load(runDir, rubricFile, id)) }));
  const rubric = readJson(rubricFile);
  let t = parts[0].t, areas;
  if (ids) {
    const w = areaWeights(runDir, ids);
    t = weigh(parts.map((p) => ({ weight: w[p.id].weight, ...p.t })));
    areas = parts.map((p) => ({ id: p.id, lines: w[p.id].lines, weight: round(w[p.id].weight), overall: p.t.overall, values: Object.fromEntries(Object.entries(p.t.values).map(([k, v]) => [k, v.delta])) }));
  }
  const rf = path.join(runDir, 'parity', 'rebuild.json');
  const g = gate(fs.existsSync(rf) ? readJson(rf) : [], rubric.gate.minPassRate);
  const dropped = parts.flatMap((p) => p.dropped), refuted = parts.flatMap((p) => p.refuted);
  const result = { gate: g, values: t.values, overall: t.overall, ...(areas ? { areas } : {}), dropped, refuted, notChecked: ['other browsers (the adapter only runs Chromium)'] };
  writeJson(path.join(runDir, 'score', 'score.json'), result);
  return result;
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const run = opt('run'), rubricOpt = opt('rubric'), seed = opt('seed'), labelsOut = opt('labels');
  const [cmd, a, b, c] = args;
  if (cmd === 'measure') {
    const m = measure(path.resolve(a), path.resolve(b), { run, rubric: rubricOpt ? readJson(rubricOpt) : undefined });
    writeJson(c, m);
    console.log(JSON.stringify(m));
  } else if (cmd === 'source') console.log(sourceOf(a, b).source);
  else if (cmd === 'blind') {
    const r = blind(path.resolve(a), Number(b), seed === undefined ? {} : { seed });
    if (labelsOut) writeJson(labelsOut, r);
    console.log(JSON.stringify(r));
  } else if (cmd === 'labels') {
    const judges = JSON.parse(c).judges || JSON.parse(c);
    const bad = verifyLabels(path.resolve(a), b, judges);
    if (bad.length) { console.error(`label map does not match the folders: ${bad.join('; ')}`); process.exit(1); }
    writeJson(path.join(a, 'score', '.labels.json'), { judges });
    console.log('labels written');
  } else if (cmd === 'check') {
    const { kept, dropped } = checkJudge(a, b);
    writeJson(c, kept);
    writeJson(c.replace(/\.json$/, '.dropped.json'), dropped);
    console.log(`dropped ${dropped.length}`);
  } else if (cmd === 'gaps') {
    const g = gaps(a, b);
    writeJson(path.join(a, 'score', 'gaps.json'), g);
    console.log(JSON.stringify(g));
  } else if (cmd === 'collate') {
    const r = collate(a, b);
    console.log(`overall ${r.overall}; gate ${r.gate.passed ? 'passed' : 'failed'}; dropped ${r.dropped.length}; refuted ${r.refuted.length}`);
  } else { console.error('usage: score.mjs measure|source|blind|check|gaps|collate ...'); process.exit(2); }
}

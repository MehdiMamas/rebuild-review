// Pass or fail decisions for the Parity phase, in code, no dependencies.
//   node parity-results.mjs wrong  <features.md> <results.json>   prints the count and the IDs of wrong tests
//   node parity-results.mjs settle <parDir> <features.md>         moves wrong and flaky tests to removed/, notes them in untested.md, rewrites original.json
//   node parity-results.mjs merge  <parDir> <features.md>         writes parity.json
import fs from 'node:fs';
import path from 'node:path';

// Map of feature ID to keep or defect, from lines that start with "F-xxx keep" or "F-xxx defect".
export function kinds(featuresMd) {
  const out = {};
  for (const line of featuresMd.split('\n')) {
    if (!/^\W*F-\d+/i.test(line)) continue;
    const m = line.match(/^\W*(F-\d+)\W+(keep|defect)\b/i);
    if (!m) throw new Error(`feature line has no keep or defect: ${line.slice(0, 80)}`);
    out[m[1].toUpperCase()] = m[2].toLowerCase();
  }
  return out;
}

// IDs of keep tests that failed and defect tests that passed.
export function wrongTests(results, kindMap) {
  return results.filter((r) => (kindMap[r.feature] === 'keep' && !r.passed) || (kindMap[r.feature] === 'defect' && r.passed)).map((r) => r.feature);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export function settle(parDir, featuresMd) {
  const kindMap = kinds(fs.readFileSync(featuresMd, 'utf8'));
  const a = readJson(path.join(parDir, 'original.json')), b = readJson(path.join(parDir, 'original-2.json'));
  const bBy = Object.fromEntries(b.map((r) => [r.feature, r]));
  const wrong = new Set([...wrongTests(a, kindMap), ...wrongTests(b, kindMap)]);
  const flaky = new Set(a.filter((r) => bBy[r.feature] && bBy[r.feature].passed !== r.passed).map((r) => r.feature));
  const notes = [];
  for (const id of [...new Set([...wrong, ...flaky])].sort()) {
    const file = path.join(parDir, 'tests', `${id}.test.mjs`);
    if (fs.existsSync(file)) { fs.mkdirSync(path.join(parDir, 'removed'), { recursive: true }); fs.renameSync(file, path.join(parDir, 'removed', `${id}.test.mjs`)); }
    notes.push(flaky.has(id) ? `${id}: flaky, its result differed between two runs on the original` : `${id}: wrong test, ${kindMap[id] === 'keep' ? 'a keep test failed' : 'a defect test passed'} on the original after the fix rounds`);
  }
  if (notes.length) fs.appendFileSync(path.join(parDir, 'untested.md'), notes.join('\n') + '\n');
  const gone = new Set([...wrong, ...flaky]);
  fs.writeFileSync(path.join(parDir, 'original.json'), JSON.stringify(a.filter((r) => !gone.has(r.feature)), null, 2));
  return notes;
}

export function merge(parDir, featuresMd) {
  const kindMap = kinds(fs.readFileSync(featuresMd, 'utf8'));
  const load = (n) => { const f = path.join(parDir, n); return fs.existsSync(f) ? Object.fromEntries(readJson(f).map((r) => [r.feature, r.passed ? 'pass' : 'fail'])) : {}; };
  const orig = load('original.json'), reb = load('rebuild.json');
  const un = {};
  const uf = path.join(parDir, 'untested.md');
  if (fs.existsSync(uf)) for (const l of fs.readFileSync(uf, 'utf8').split('\n')) { const m = l.match(/^\W*(F-\d+)\W*:\s*(.*)$/i); if (m) un[m[1].toUpperCase()] = m[2]; }
  const out = Object.keys(kindMap).sort().map((feature) => {
    if (un[feature] !== undefined) return { feature, kind: kindMap[feature], original: 'not run', rebuild: 'not run', note: un[feature] };
    const original = orig[feature] || 'not run', rebuild = reb[feature] || 'not run';
    const note = original !== 'not run' && rebuild !== 'not run' && original !== rebuild ? `${original} on the original, ${rebuild} on the rebuild` : '';
    return { feature, kind: kindMap[feature], original, rebuild, note };
  });
  fs.writeFileSync(path.join(parDir, 'parity.json'), JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, x, y] = process.argv.slice(2);
  if (cmd === 'wrong') {
    const ids = wrongTests(readJson(y), kinds(fs.readFileSync(x, 'utf8')));
    console.log(`${ids.length}${ids.length ? ' ' + ids.join(' ') : ''}`);
  } else if (cmd === 'settle') {
    const n = settle(x, y);
    console.log(`moved ${n.length}${n.length ? '\n' + n.join('\n') : ''}`);
  } else if (cmd === 'merge') {
    console.log(`parity.json: ${merge(x, y).length} features`);
  } else { console.error('usage: parity-results.mjs wrong|settle|merge ...'); process.exit(2); }
}

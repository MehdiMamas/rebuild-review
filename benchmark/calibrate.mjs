// Records one known-answer run: what the tool said against what it should have said.
// node benchmark/calibrate.mjs <runDir> --expect adopt|port|leave --kind same|worse|fixed [--file calibration.json]
// Appends {kind, expected, got, right, overall, sourceLines, commit, date} to benchmark/calibration.json. A wrong verdict is kept.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verdict } from '../scripts/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function record(runDir, { expect, kind, file = path.join(HERE, 'calibration.json'), commit, date = new Date().toISOString().slice(0, 10) }) {
  if (!['adopt', 'port', 'leave'].includes(expect)) throw new Error('--expect must be adopt, port or leave');
  if (!['same', 'worse', 'fixed'].includes(kind)) throw new Error('--kind must be same, worse or fixed');
  const score = JSON.parse(fs.readFileSync(path.join(runDir, 'score', 'score.json'), 'utf8'));
  const got = verdict(score).verdict;
  const lines = ((score.values.simplicity || {}).measured || []).find((m) => m.name === 'lines');
  if (!lines) throw new Error('score.json has no measured lines for the original, so the size of the target is unknown');
  if (!commit) commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim();
  const entry = { kind, expected: expect, got, right: got === expect, overall: score.overall, sourceLines: lines.original, commit, date };
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  all.push(entry);
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
  return entry;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  if (!a[0] || a[0].startsWith('--')) { console.error('usage: calibrate.mjs <runDir> --expect adopt|port|leave --kind same|worse|fixed'); process.exit(2); }
  const e = record(path.resolve(a[0]), { expect: opt('expect'), kind: opt('kind'), file: opt('file') });
  console.log(JSON.stringify(e));
}

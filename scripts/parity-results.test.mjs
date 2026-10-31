import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kinds, wrongTests, settle, merge } from './parity-results.mjs';

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

test('kinds ignores the "Not built (from the docs)" section (bullets without an F-id)', () => {
  const withSection = md + '\n## Not built (from the docs)\n- Export to PDF is described in the docs but the app has no such control.\n- Dark theme toggle is documented only.\n';
  assert.deepEqual(kinds(withSection), { 'F-001': 'keep', 'F-002': 'defect', 'F-003': 'keep' });
});

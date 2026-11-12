import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record } from './calibrate.mjs';

test('record refuses a run where no parity test ran', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-test-'));
  try {
    fs.mkdirSync(path.join(d, 'score'));
    fs.writeFileSync(path.join(d, 'score', 'score.json'), JSON.stringify({ gate: { passed: false, rate: null, failing: [] }, overall: 10, values: { speed: { delta: 0.4 } } }));
    const file = path.join(d, 'calibration.json');
    assert.throws(() => record(d, { expect: 'adopt', kind: 'same', file, commit: 'abc', date: '2026-01-01' }), /no verdict/);
    assert.ok(!fs.existsSync(file), 'nothing may be recorded');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emit, read, tryEmit, mask } from './events.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'events-'));
const cli = fileUrl();
function fileUrl() { return new URL('./events.mjs', import.meta.url).pathname; }

test('emit appends one JSON line with a time, read returns them and the next offset', () => {
  const d = tmp();
  emit(d, { kind: 'phase', phase: 'Capture', state: 'start' });
  const a = read(d, 0);
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].phase, 'Capture');
  assert.ok(!Number.isNaN(Date.parse(a.events[0].t)));
  emit(d, { kind: 'decision', what: 'estimate', choice: 'go', reason: 'ok' });
  const b = read(d, a.nextByte);
  assert.deepEqual(b.events.map((e) => e.kind), ['decision']);
  assert.equal(read(d, b.nextByte).events.length, 0);
  assert.equal(read(d, 0).events.length, 2);
  assert.equal(fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8').split('\n').length, 3);
});

test('a half-written last line waits for the next read', () => {
  const d = tmp();
  emit(d, { kind: 'made', what: 'a' });
  fs.appendFileSync(path.join(d, 'events.jsonl'), '{"kind":"made","wh');
  const a = read(d, 0);
  assert.equal(a.events.length, 1);
  fs.appendFileSync(path.join(d, 'events.jsonl'), 'at":"b"}\n');
  assert.deepEqual(read(d, a.nextByte).events.map((e) => e.what), ['b']);
});

test('read of a missing file is empty', () => {
  assert.deepEqual(read(tmp(), 0), { events: [], nextByte: 0 });
});

test('values of run.json env are masked, in nested values too', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ env: { API_KEY: 'sekrit-123', EMPTY: '' } }));
  emit(d, { kind: 'decision', what: 'x', choice: 'key sekrit-123 here', reason: 'a', extra: { deep: ['sekrit-123'] } });
  const text = fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8');
  assert.ok(!text.includes('sekrit-123'));
  assert.ok(text.includes('key *** here'));
  assert.ok(text.includes('["***"]'));
});

test('strings are cut to 500 characters', () => {
  const d = tmp();
  emit(d, { kind: 'decision', what: 'x'.repeat(2000), choice: 'y', reason: 'z' });
  assert.equal(read(d, 0).events[0].what.length, 500);
});

test('CLI form appends, a bad kind or bad JSON exits 2', () => {
  const d = tmp();
  const ok = spawnSync('node', [cli, d, 'made', '{"what":"features","path":"features.md","count":3}']);
  assert.equal(ok.status, 0);
  assert.equal(read(d, 0).events[0].count, 3);
  assert.equal(spawnSync('node', [cli, d, 'nope', '{}']).status, 2);
  assert.equal(spawnSync('node', [cli, d, 'made', 'not json']).status, 2);
});

test('tryEmit never throws', () => {
  const f = path.join(tmp(), 'file');
  fs.writeFileSync(f, 'x');
  assert.doesNotThrow(() => tryEmit(path.join(f, 'sub'), { kind: 'made', what: 'a' }));
});

test('given auth values in run.json -> events.mjs writes *** for them in events.jsonl', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ auth: { steps: [{ open: '/login' }, { type: { into: 'Email', text: 'pat@example.test' } }, { type: { into: 'Password', text: 'stand-in-pw-1' } }, { type: { into: 'Code', text: 'abc' } }] } }));
  emit(d, { kind: 'decision', what: 'signed in as pat@example.test', choice: 'pw stand-in-pw-1', reason: 'code abc' });
  const text = fs.readFileSync(path.join(d, 'events.jsonl'), 'utf8');
  assert.ok(!text.includes('pat@example.test') && !text.includes('stand-in-pw-1'));
  assert.ok(text.includes('signed in as ***') && text.includes('pw ***'));
  assert.ok(text.includes('code abc'), 'a 3-character value is too short to mask');
});

test('given auth values -> mask in events/watch logs hides them', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ env: { K: 'env-value-1' }, auth: { steps: [{ type: { into: 'Password', text: 'stand-in-pw-1' } }, { type: { into: 'Code', text: 'abc' } }] } }));
  assert.equal(mask(d, 'log: stand-in-pw-1 env-value-1 abc'), 'log: *** *** abc');
});

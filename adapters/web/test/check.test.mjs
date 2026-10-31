import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { statusOf, exitCodeOf } from '../check-result.mjs';

const f = [{ probe: 'p', route: '/', evidence: 'e' }], n = [{ probe: 'p', route: '/', reason: 'r' }];

test('a failure outranks incomplete', () => assert.strictEqual(statusOf({ failed: f, notChecked: n }), 'fail'));
test('not checked is never a pass', () => assert.strictEqual(statusOf({ failed: [], notChecked: n }), 'incomplete'));
test('nothing failed and nothing skipped is a pass', () => assert.strictEqual(statusOf({ failed: [], notChecked: [] }), 'pass'));
test('exit codes', () => {
  assert.deepStrictEqual(['pass', 'fail', 'incomplete', 'error'].map(exitCodeOf), [0, 1, 2, 3]);
  assert.strictEqual(exitCodeOf('whatever'), 3);
});

const check = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check.mjs');
const run = (...a) => spawnSync('node', [check, ...a], { encoding: 'utf8' });
for (const [name, args] of [
  ['no arguments', []],
  ['no routes', ['--base-url', 'http://127.0.0.1:1']],
  ['bad url', ['--base-url', 'nope', '--routes', '/']],
  ['route without a slash', ['--base-url', 'http://127.0.0.1:1', '--routes', 'a']],
  ['bad budget', ['--base-url', 'http://127.0.0.1:1', '--routes', '/', '--budget-seconds', 'x']],
  ['missing storage state', ['--base-url', 'http://127.0.0.1:1', '--routes', '/', '--storage-state', '/nonexistent.json']],
]) test(`argument error exits 3: ${name}`, () => { const r = run(...args); assert.strictEqual(r.status, 3); assert.match(r.stderr, /^error:/); });

import { isDataRequest } from '../context.mjs';
const fakeReq = (headers = {}, url = 'http://localhost:3000/api/x', type = 'fetch') => ({ resourceType: () => type, headers: () => headers, url: () => url });
test('a plain fetch is a data request', () => assert.strictEqual(isDataRequest(fakeReq()), true));
test('an xhr is a data request', () => assert.strictEqual(isDataRequest(fakeReq({}, undefined, 'xhr')), true));
test('a document is not a data request', () => assert.strictEqual(isDataRequest(fakeReq({}, undefined, 'document')), false));
test('sec-purpose prefetch is not data', () => assert.strictEqual(isDataRequest(fakeReq({ 'sec-purpose': 'prefetch' })), false));
test('purpose prefetch is not data', () => assert.strictEqual(isDataRequest(fakeReq({ purpose: 'prefetch' })), false));
test('next-router-prefetch is not data', () => assert.strictEqual(isDataRequest(fakeReq({ 'next-router-prefetch': '1' })), false));
test('rsc without next-action is not data', () => assert.strictEqual(isDataRequest(fakeReq({ rsc: '1' })), false));
test('rsc with next-action stays data', () => assert.strictEqual(isDataRequest(fakeReq({ rsc: '1', 'next-action': 'abc' })), true));
test('/_next/data/ path is not data', () => assert.strictEqual(isDataRequest(fakeReq({}, 'http://localhost:3000/_next/data/x/a.json')), false));

import test from 'node:test';
import assert from 'node:assert/strict';
import { leftOrigin } from '../probes.mjs';

test('same origin is not left', () => {
  assert.equal(leftOrigin('http://localhost:3000/a', 'http://localhost:3000/b?x=1'), false);
});
test('another origin is left', () => {
  assert.equal(leftOrigin('http://localhost:3000/a', 'http://localhost:4000/reports'), true);
});
test('unreadable or blank urls are not judged as left', () => {
  assert.equal(leftOrigin('http://localhost:3000/a', 'about:blank'), false);
  assert.equal(leftOrigin('', 'http://localhost:3000/'), false);
});

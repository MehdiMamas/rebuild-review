import test from 'node:test';
import assert from 'node:assert/strict';
import { routeKey, pickNext, leftOver } from '../crawl.mjs';

const O = 'http://localhost:1';
const key = (u) => new URL(u).pathname + new URL(u).search;

test('routeKey turns ids into :id', () => {
  assert.equal(routeKey('/candidates/123e4567-e89b-12d3-a456-426614174000'), '/candidates/:id');
  assert.equal(routeKey('/items/42/edit'), '/items/:id/edit');
  assert.equal(routeKey('/x/deadbeef01'), '/x/:id');
  assert.equal(routeKey('/settings'), '/settings');
  assert.equal(routeKey('/candidates/new'), '/candidates/new');
  assert.equal(routeKey('/'), '/');
});

// Same loop as capture.mjs, without a browser.
function crawl(links, max, perRoute) {
  const queue = [`${O}/`], seen = new Map(), counts = new Map(), visited = [];
  while (queue.length) {
    const at = pickNext(queue, counts, seen, key, perRoute);
    if (at < 0) break;
    const url = queue.splice(at, 1)[0];
    if (seen.size >= max) { queue.unshift(url); break; }
    const rk = routeKey(new URL(url).pathname);
    counts.set(rk, (counts.get(rk) || 0) + 1);
    seen.set(key(url), true);
    visited.push(key(url));
    queue.push(...(links[key(url)] || []));
  }
  return { visited, ...leftOver(queue, counts, seen, key) };
}

test('30 same-route links plus /settings and /candidates/new: both get visited, 2 of the 30', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `${O}/candidates/${String(i).padStart(8, '0')}-e89b-12d3-a456-426614174000`);
  const links = { '/': [...ids, `${O}/settings`, `${O}/candidates/new`] };
  const r = crawl(links, 30, 2);
  assert.ok(r.visited.includes('/settings'));
  assert.ok(r.visited.includes('/candidates/new'));
  assert.equal(r.visited.filter((v) => /^\/candidates\/\d{8}-/.test(v)).length, 2);
  assert.deepEqual(r.cut, []);
  assert.deepEqual(r.sameRouteSkipped, [{ route: '/candidates/:id', count: 28 }]);
});

test('the screen cap cuts distinct routes, not same-route repeats', () => {
  const links = { '/': [`${O}/a`, `${O}/b`, `${O}/c`, `${O}/items/1`, `${O}/items/2`, `${O}/items/3`] };
  const r = crawl(links, 3, 2);
  assert.equal(r.visited.length, 3);
  assert.deepEqual(r.visited, ['/', '/a', '/b']);
  assert.deepEqual(r.cut, ['/c', '/items/1']);
  assert.deepEqual(r.sameRouteSkipped, [{ route: '/items/:id', count: 2 }]);
});

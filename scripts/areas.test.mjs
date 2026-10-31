import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { validate, renumber, featureAreas, buildOrder, failureIds, SINGLE } from './areas.mjs';
import { areaStackNote, areaBuildNote } from './room.mjs';

const CLI = new URL('./areas.mjs', import.meta.url).pathname;
const SIZE = new URL('./size.mjs', import.meta.url).pathname;
const lines = (n) => 'x\n'.repeat(n);
// A run folder whose work/ is a generated big app: three folders of 150,000 lines each (23 units).
function bigRun() {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-areas-'));
  const work = path.join(run, 'work');
  for (const [f, n] of Object.entries({ 'cart/a.js': 150000, 'search/b.js': 150000, 'admin/c.js': 150000, 'tools/gen.js': 10, 'README.md': 3 })) {
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), lines(n));
  }
  execFileSync('git', ['init', '-q'], { cwd: work });
  execFileSync('git', ['add', '-A'], { cwd: work });
  return run;
}
const cli = (...a) => spawnSync('node', [CLI, ...a], { encoding: 'utf8' });
const counted = [{ path: 'cart/a.js', lines: 5 }, { path: 'search/b.js', lines: 7 }, { path: 'tools/gen.js', lines: 2 }];

test('validate: every counted file in exactly one area or one exclusion with a reason', () => {
  const ok = validate({ areas: [{ id: 'cart', paths: ['cart'] }, { id: 'search', paths: ['search/'] }], exclusions: [{ path: 'tools', reason: 'build helper' }] }, counted);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.areas.map((a) => [a.id, a.files, a.lines]), [['cart', 1, 5], ['search', 1, 7]]);
  assert.deepEqual(ok.excluded, [{ path: 'tools', reason: 'build helper', files: 1 }]);
});

test('validate refuses a missing file, a double claim, an empty reason, a bad or repeated id, an empty area', () => {
  const miss = validate({ areas: [{ id: 'cart', paths: ['cart'] }, { id: 'search', paths: ['search'] }] }, counted);
  assert.equal(miss.ok, false);
  assert.match(miss.problems.join('\n'), /tools\/gen\.js: in no area and no exclusion/);
  const dbl = validate({ areas: [{ id: 'a', paths: ['.'] }, { id: 'b', paths: ['cart'] }] }, counted);
  assert.match(dbl.problems.join('\n'), /cart\/a\.js: in more than one place/);
  const both = validate({ areas: [{ id: 'a', paths: ['.'] }], exclusions: [{ path: 'tools', reason: 'x' }] }, counted);
  assert.match(both.problems.join('\n'), /gen\.js: in more than one place/);
  assert.match(validate({ areas: [{ id: 'a', paths: ['.'] }], exclusions: [{ path: 'zzz', reason: ' ' }] }, counted).problems.join(), /no reason/);
  assert.match(validate({ areas: [{ id: 'A b', paths: ['.'] }] }, counted).problems.join(), /not lowercase/);
  assert.match(validate({ areas: [{ id: 'a', paths: ['.'] }, { id: 'a', paths: ['nothing'] }] }, counted).problems.join(), /used twice/);
  assert.match(validate({ areas: [{ id: 'a', paths: ['.'] }, { id: 'b', paths: ['nothing'] }] }, counted).problems.join(), /area b holds no counted files/);
  assert.equal(validate({ areas: [] }, counted).ok, false);
  assert.equal(validate(SINGLE, counted).ok, true);
});

test('renumber joins areas in order with global IDs, tags and remapped references; featureAreas reads the tags', () => {
  const spec = { areas: [{ id: 'cart' }, { id: 'search' }] };
  const src = { cart: 'F-001 keep. Add item\nF-002 defect. Total wrong, see F-001\n  more text', search: 'F-001 keep. Find it (like cart F-001)\n' };
  const { text, map } = renumber(spec, (id) => src[id]);
  assert.deepEqual(map, { cart: ['F-001', 'F-002'], search: ['F-003'] });
  assert.match(text, /^F-001 keep\. \[area: cart\] Add item$/m);
  assert.match(text, /^F-002 defect\. \[area: cart\] Total wrong, see F-001$/m);
  assert.match(text, /^F-003 keep\. \[area: search\] Find it \(like cart F-003\)$/m);
  assert.deepEqual(featureAreas(text, spec), { 'F-001': 'cart', 'F-002': 'cart', 'F-003': 'search' });
  assert.throws(() => featureAreas('F-001 keep. no tag\n', spec), /no valid \[area/);
  assert.equal(featureAreas('F-001 keep. x\n', { areas: [{ id: 'all' }] })['F-001'], 'all');
  assert.throws(() => renumber(spec, () => null), /no features file/);
});

test('CLI on a generated big app: init asks for a proposal, check accepts a good areas.json and refuses a bad one, joins work', () => {
  const run = bigRun();
  assert.equal(spawnSync('node', [SIZE, path.join(run, 'work'), run], { encoding: 'utf8' }).status, 0);
  assert.equal(cli('init', run).stdout.trim(), 'needs-proposal');
  assert.match(cli('tree', path.join(run, 'work')).stdout, /150000 cart\/a\.js/);
  const good = { areas: [{ id: 'cart', paths: ['cart'] }, { id: 'search', paths: ['search'] }, { id: 'admin', paths: ['admin'] }], exclusions: [{ path: 'tools', reason: 'build helper' }] };
  fs.writeFileSync(path.join(run, 'areas.json'), JSON.stringify(good));
  const ck = cli('check', run);
  assert.equal(ck.status, 0);
  assert.deepEqual(JSON.parse(ck.stdout).areas.map((a) => [a.id, a.lines]), [['cart', 150000], ['search', 150000], ['admin', 150000]]);
  fs.writeFileSync(path.join(run, 'areas.json'), JSON.stringify({ areas: good.areas }));
  const bad = cli('check', run);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /tools\/gen\.js: in no area and no exclusion/);
  fs.writeFileSync(path.join(run, 'areas.json'), JSON.stringify(good));
  for (const [id, t] of Object.entries({ cart: 'F-001 keep. A\n', search: 'F-001 defect. B\n', admin: 'F-001 keep. C\n' })) {
    fs.mkdirSync(path.join(run, 'inventory-areas', id), { recursive: true });
    fs.writeFileSync(path.join(run, 'inventory-areas', id, 'features.md'), t);
    fs.writeFileSync(path.join(run, 'inventory-areas', id, 'states.json'), JSON.stringify([{ id: 's1', steps: [] }]));
  }
  assert.equal(cli('renumber', run).status, 0);
  assert.equal(cli('ids', run, 'search').stdout.trim(), 'F-002');
  assert.match(cli('states', run).stdout, /3 states/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'inventory', 'states.json'), 'utf8'))[1].id, 'search:s1');
  fs.mkdirSync(path.join(run, 'parity'));
  fs.writeFileSync(path.join(run, 'parity', 'untested-cart.md'), 'F-001: hidden\n');
  fs.writeFileSync(path.join(run, 'parity', 'untested-admin.md'), 'F-003: gone\n');
  cli('untested', run);
  assert.equal(fs.readFileSync(path.join(run, 'parity', 'untested.md'), 'utf8'), 'F-003: gone\nF-001: hidden\n');
});

test('a small repo gets the single area without a proposal', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-areas-small-'));
  assert.equal(cli('init', run).stdout.trim(), 'single');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'areas.json'), 'utf8')), SINGLE);
});

test('buildOrder reads the Build order list, one item per area, each exactly once', () => {
  const md = '# Stack\nx\n## Build order\n1. admin - first, others use it\n2. cart (needs admin)\n- search\n## Shared contracts\n- cart and search share the price shape\n';
  assert.deepEqual(buildOrder(md, ['cart', 'search', 'admin']), ['admin', 'cart', 'search']);
  assert.throws(() => buildOrder('# Stack\n', ['cart']), /no "Build order"/);
  assert.throws(() => buildOrder('## Build order\n- cart\n', ['cart', 'search']), /does not list: search/);
  assert.throws(() => buildOrder('## Build order\n- cart\n- cart again\n- search\n', ['cart', 'search']), /twice: cart/);
});

test('failureIds reads the feature IDs of failures.md; the notes name the area and its features', () => {
  assert.deepEqual(failureIds('## F-002 (defect)\nx\n## f-010 (keep)\ny\n'), ['F-002', 'F-010']);
  assert.match(areaStackNote(['cart', 'search'], { cart: 3, search: 4 }), /cart \(3 features.*Build order.*Shared contracts/s);
  const n = areaBuildNote('cart', ['F-001', 'F-003'], ['cart', 'search'], true, new Set(['F-003']));
  assert.match(n, /only the area "cart".*F-001, F-003/s);
  assert.match(n, /Fix only failures listed for these features: F-003\./);
});

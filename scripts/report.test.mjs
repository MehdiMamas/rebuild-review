import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verdict, checkActions, render, parseCompare, esc } from './report.mjs';

const T = { adoptOverall: 15, worseValue: -0.15 };
const sc = (over = {}) => ({ gate: { passed: true, rate: 0.97, failing: [] }, overall: 41, values: { speed: { delta: 0.4 }, ux: { delta: 0.2 } }, notChecked: ['other browsers'], dropped: [], refuted: [], ...over });
const w = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof t === 'string' || Buffer.isBuffer(t) ? t : JSON.stringify(t)); };

function makeRun({ screens = true, compare = true, actions } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
  w(path.join(d, 'score/score.json'), sc({ values: { speed: { delta: 0.4, measured: [{ name: 'lcp' }], notMeasured: ['heap-mb'] }, ux: { delta: 0.2, measured: [], notMeasured: [] } } }));
  if (compare) w(path.join(d, 'score/compare.md'), '## speed\n### was\nSlow <b>x</b>\n### now\nFast\n### should\nKeep\n');
  w(path.join(d, 'parity/parity.json'), [
    { feature: 'F-001', kind: 'keep', original: 'pass', rebuild: 'pass', note: '' },
    { feature: 'F-002 <script>alert(1)</script>', kind: 'keep', original: 'pass', rebuild: 'fail', note: '"><img onerror=alert(1)>' },
  ]);
  w(path.join(d, 'work/src/a.js'), 'one\ntwo\n');
  if (screens) for (const side of ['golden', 'golden-rebuild']) for (const s of ['home', 'about']) w(path.join(d, side, 'screens', s, '1280-light.png'), Buffer.alloc(1000, 7));
  if (screens) w(path.join(d, 'parity/visual-diff.json'), { diffs: [{ screen: 'home', size: 1280, theme: 'light', percent: 1 }, { screen: 'about', size: 1280, theme: 'light', percent: 9 }], onlyIn: [] });
  w(path.join(d, 'report/actions.json'), actions || [
    { title: 'Low one', impact: 'low', change: 'c', evidence: [{ kind: 'metric', ref: 'lcp' }] },
    { title: 'Evil "><img onerror=alert(1)> <script>x</script>', impact: 'high', impactWhy: 'w', change: 'c', evidence: [{ kind: 'metric', ref: 'lcp' }] },
  ]);
  return d;
}

test('verdict table', () => {
  assert.equal(verdict(sc(), T).verdict, 'adopt');
  assert.match(verdict(sc(), T).why, /Gate passed \(97%\), overall \+41, no value worse/);
  assert.equal(verdict(sc({ gate: { passed: false, rate: 0.5, failing: ['F-1'] } }), T).verdict, 'port');
  assert.match(verdict(sc({ gate: { passed: false, rate: 0.5 } }), T).why, /^Gate failed \(50%\)/);
  assert.equal(verdict(sc({ overall: 5, values: { speed: { delta: 0.4 } } }), T).verdict, 'port');
  assert.equal(verdict(sc({ overall: 5, values: { speed: { delta: 0.1 } } }), T).verdict, 'leave');
  assert.equal(verdict(sc({ overall: 15 }), T).verdict, 'adopt');
  assert.equal(verdict(sc({ overall: 14.9 }), T).verdict, 'port');
});

test('a value exactly at the threshold is worse', () => {
  const v = verdict(sc({ values: { speed: { delta: 0.5 }, ux: { delta: -0.15 } } }), T);
  assert.equal(v.verdict, 'port');
  assert.match(v.why, /Worse in: ux/);
  assert.equal(verdict(sc({ values: { speed: { delta: 0.5 }, ux: { delta: -0.1499 } } }), T).verdict, 'adopt');
});

test('no score or no rebuild is leave', () => {
  for (const s of [null, undefined, {}, { gate: { passed: true } }]) {
    const v = verdict(s, T);
    assert.equal(v.verdict, 'leave');
    assert.match(v.why, /no score/);
  }
});

test('check-actions drops each false citation and keeps real ones', () => {
  const d = makeRun();
  w(path.join(d, 'golden/screens/home/a.png'), 'x');
  const ok = [
    { kind: 'metric', ref: 'lcp' }, { kind: 'file', ref: 'work/src/a.js:2' }, { kind: 'shot', ref: 'golden/screens/home/1280-light.png' }, { kind: 'feature', ref: 'F-001' },
  ];
  const bad = [
    { kind: 'metric', ref: 'nope' }, { kind: 'file', ref: 'work/src/a.js:99' }, { kind: 'file', ref: 'work/missing.js' }, { kind: 'file', ref: 'work/../score/score.json' },
    { kind: 'shot', ref: 'golden/screens/none.png' }, { kind: 'shot', ref: 'score/score.json' }, { kind: 'feature', ref: 'F-999' }, { kind: 'weird', ref: 'x' },
  ];
  const proposed = [
    ...ok.map((e, i) => ({ title: 'ok' + i, impact: 'high', evidence: [e] })),
    ...bad.map((e, i) => ({ title: 'bad' + i, impact: 'high', evidence: [ok[0], e] })),
    { title: 'none', impact: 'high', evidence: [] },
  ];
  w(path.join(d, 'report/actions.proposed.json'), proposed);
  const r = checkActions(d);
  assert.equal(r.kept.length, 4);
  assert.equal(r.dropped.length, bad.length + 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'report/actions.json'))).length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'report/actions.dropped.json'))).length, bad.length + 1);
});

test('escaping: hostile strings are inert, no script, no outside URL', () => {
  const d = makeRun();
  const html = render(d, { thresholds: T });
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('"><img'));
  assert.ok(!/<img[^>]*onerror/i.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/(src|href)="https?:/i.test(html));
  assert.match(html, /Content-Security-Policy/);
  assert.equal(esc('<a b="c">'), '&lt;a b=&quot;c&quot;&gt;');
});

test('section order, gate beside scores, first action', () => {
  const html = render(makeRun(), { thresholds: T });
  const ids = ['verdict', 'scores', 'actions', 'compare', 'features', 'unchecked', 'cost', 'project'].map((i) => html.indexOf(`id="${i}"`));
  assert.ok(ids.every((n) => n >= 0));
  assert.deepEqual([...ids].sort((a, b) => a - b), ids);
  const scores = html.slice(html.indexOf('id="scores"'), html.indexOf('id="actions"'));
  assert.match(scores, /Gate \(functionality\)/);
  assert.match(html.slice(0, html.indexOf('id="scores"')), /Do this first:<\/strong> Evil/);
  assert.ok(html.indexOf('Evil') < html.indexOf('Low one'), 'high impact first');
  assert.ok(html.indexOf('F-002') < html.indexOf('F-001'), 'failures first');
  assert.match(html, /Other browsers: not checked/);
  assert.match(html, /heap-mb was not measured/);
  assert.match(html, /other agents are not counted/);
});

test('screenshot pairs: largest difference first, embed cap', () => {
  const d = makeRun();
  const html = render(d, { thresholds: T });
  assert.ok(html.indexOf('about/1280-light.png') < html.indexOf('home/1280-light.png'));
  const small = render(d, { thresholds: T, embedCap: 2000 });
  assert.equal((small.match(/<img /g) || []).length, 0);
  assert.match(small, /left out/);
  const one = render(d, { thresholds: T, embedCap: 3000 });
  assert.equal((one.match(/<img /g) || []).length, 2);
  assert.match(one, /1 more screenshot pair\(s\) left out/);
});

test('a platform with no screens', () => {
  const html = render(makeRun({ screens: false }), { thresholds: T });
  assert.match(html, /no screens on this platform/);
});

test('missing compare.md prints not written and does not fail', () => {
  const html = render(makeRun({ compare: false }), { thresholds: T });
  assert.match(html, /not written/);
});

test('compare.md parses', () => {
  const c = parseCompare('## speed\n### was\na\nb\n### now\nc\n## ux\n### should\nd');
  assert.deepEqual(c.speed, { was: 'a\nb', now: 'c' });
  assert.deepEqual(c.ux, { should: 'd' });
});

test('empty run folder renders the leave page; work/ is untouched', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'report-empty-'));
  w(path.join(d, 'work/keep.txt'), 'x');
  const before = fs.readdirSync(d).sort().join();
  const html = render(d, { thresholds: T });
  assert.match(html, /badge leave/);
  assert.ok(fs.existsSync(path.join(d, 'report/index.html')));
  assert.equal(fs.readFileSync(path.join(d, 'work/keep.txt'), 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(d).sort(), [...before.split(','), 'report'].sort());
});

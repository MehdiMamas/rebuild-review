import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detect, fetchBase, checkWall, parsePin, ownSince, git } from './base.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-base-test-'));
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
function sh(cwd, ...a) { const r = spawnSync('git', [...G, ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function write(d, files) { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); } }
const lines = (n, s = 'x') => `${s}\n`.repeat(n);

// An upstream with two commits, and a fork of it with two own commits.
function fixture() {
  const upDir = tmp();
  const up = upDir;
  sh(up, 'init', '-q', '-b', 'main');
  write(up, { 'core/a.js': lines(30), 'core/b.js': lines(20) });
  sh(up, 'add', '-A'); sh(up, 'commit', '-q', '-m', 'one');
  write(up, { 'core/c.js': lines(10) });
  sh(up, 'add', '-A'); sh(up, 'commit', '-q', '-m', 'two');
  sh(up, 'tag', 'v1');
  const upCommit = sh(up, 'rev-parse', 'HEAD');
  const fork = tmp();
  sh(fork, 'clone', '-q', up, '.');
  sh(fork, 'remote', 'set-url', 'origin', 'file://' + up);
  sh(fork, 'remote', 'rename', 'origin', 'upstream');
  write(fork, { 'own/feature.js': lines(7), 'core/a.js': lines(31) });
  sh(fork, 'add', '-A'); sh(fork, 'commit', '-q', '-m', 'own feature');
  write(fork, { 'own/more.js': lines(3) });
  sh(fork, 'add', '-A'); sh(fork, 'commit', '-q', '-m', 'own more');
  return { up: 'file://' + up, upDir, upCommit, fork };
}

test('detect finds the upstream commit and exactly the own paths', () => {
  const { up, upCommit, fork } = fixture();
  const run = tmp();
  const b = detect(fork, run);
  assert.equal(b.kind, 'fork');
  assert.equal(b.upstream.commit, upCommit);
  assert.equal(b.upstream.ref, 'v1');
  assert.equal(b.upstream.url, up);
  assert.deepEqual([...b.ownPaths].sort(), ['core/a.js', 'own/feature.js', 'own/more.js']);
  assert.equal(b.ownLines, 31 + 7 + 3);
  assert.ok(b.evidence.some((e) => /upstream/.test(e)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'base.json'), 'utf8')).ownPaths.sort(), b.ownPaths.sort());
});

test('a plain app gives none', () => {
  const d = tmp();
  sh(d, 'init', '-q', '-b', 'main');
  write(d, { 'a.js': lines(5), 'package.json': '{"name":"x"}' });
  sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', 'one');
  const b = detect(d, tmp());
  assert.equal(b.kind, 'none');
  assert.equal(b.upstream, null);
  assert.equal(b.ownPaths, null);
});

test('a pinned base in run.json wins, and "none" turns detection off', () => {
  const { up, upDir, upCommit, fork } = fixture();
  const first = sh(upDir, 'rev-list', '--max-parents=0', 'HEAD');
  const run = tmp();
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ base: { url: up, ref: first } }));
  const b = detect(fork, run);
  assert.equal(b.upstream.commit, first);
  assert.notEqual(b.upstream.commit, upCommit);
  assert.ok(b.evidence[0].startsWith('pinned in run.json'));
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ base: 'none' }));
  const n = detect(fork, run);
  assert.equal(n.kind, 'none');
  assert.equal(n.upstream, null);
});

test('parsePin takes url@ref or none and refuses odd addresses', () => {
  assert.equal(parsePin('none'), 'none');
  assert.deepEqual(parsePin('https://example.com/a/b.git@v2'), { url: 'https://example.com/a/b.git', ref: 'v2' });
  assert.deepEqual(parsePin('git@example.com:a/b.git@v2'), { url: 'git@example.com:a/b.git', ref: 'v2' });
  assert.throws(() => parsePin('https://example.com/a/b'));
  assert.throws(() => parsePin('ext::sh -c x@v1'));
});

test('fetchBase gets the pinned commit and refuses a wrong hash', () => {
  const { up, upCommit } = fixture();
  const dest = path.join(tmp(), 'base');
  fetchBase({ url: up, commit: upCommit, dest });
  assert.equal(git(dest, 'rev-parse', 'HEAD').out, upCommit);
  assert.ok(fs.existsSync(path.join(dest, 'core', 'c.js')));
  assert.throws(() => fetchBase({ url: up, commit: 'f'.repeat(40), dest: path.join(tmp(), 'b2') }));
});

test('the wall holds for a real upstream and refuses a base with the target own commits or own content', () => {
  const { up, upCommit, fork } = fixture();
  const own = ['core/a.js', 'own/feature.js', 'own/more.js'];
  const good = path.join(tmp(), 'good');
  fetchBase({ url: up, commit: upCommit, dest: good });
  assert.deepEqual(checkWall({ workDir: fork, baseDir: good, commit: upCommit, ownPaths: own }), []);
  // A "base" that is the fork itself holds the target's own commits and content.
  const bad = path.join(tmp(), 'bad');
  sh(path.dirname(bad), 'clone', '-q', fork, bad);
  const p = checkWall({ workDir: fork, baseDir: bad, commit: upCommit, ownPaths: own }).join('\n');
  assert.match(p, /own commits/);
  assert.match(p, /own path/);
});

test('ownSince lists files changed after the first commit of a project', () => {
  const d = tmp();
  sh(d, 'init', '-q', '-b', 'main');
  write(d, { 'base.js': lines(3) });
  sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', 'base');
  write(d, { 'new.js': lines(2), 'base.js': lines(4) });
  sh(d, 'add', '-A'); sh(d, 'commit', '-q', '-m', 'own');
  assert.deepEqual([...ownSince(d)].sort(), ['base.js', 'new.js']);
});
